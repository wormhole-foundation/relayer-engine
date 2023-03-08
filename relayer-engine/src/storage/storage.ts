import { WatchError } from "redis";
import {
  OpaqueTx,
  Plugin,
  StagingAreaKeyLock,
  Workflow,
  WorkflowId,
  WorkflowOptions,
} from "../../packages/relayer-plugin-interface";
import { Logger } from "winston";
import {
  Direction,
  EmitterRecord,
  EmitterRecordKey,
  EmitterRecordWithKey,
  IRedis,
  WorkflowWithPlugin,
} from ".";
import { getLogger, getScopedLogger } from "../helpers/logHelper";
import { EngineError, nnull } from "../utils/utils";
import { MAX_ACTIVE_WORKFLOWS } from "../executor/executorHarness";
import { RedisWrapper } from "./redisStore";
import { ChainId } from "@certusone/wormhole-sdk";
import { CommonEnv, RedisConfig } from "../config";
import { constantsWithNamespace } from "./dbConstants";

type SerializedWorkflowKeys = { [k in keyof Workflow]: string | number };

export async function createStorage(
  plugins: Plugin[],
  config: CommonEnv,
  nodeId: string,
  logger: Logger = getLogger(),
): Promise<Storage> {
  const redisConfig = config.redis as RedisConfig;
  if (!redisConfig.host || !redisConfig.port) {
    throw new EngineError(
      "Redis config values must be present if redis store type selected",
    );
  }
  return new Storage(
    await RedisWrapper.fromConfig(redisConfig),
    plugins,
    config.defaultWorkflowOptions,
    nodeId,
    logger,
    config.namespace,
  );
}

function sanitize(dirtyString: string): string {
  return dirtyString.replace("[^a-zA-z_0-9]*", "");
}

function emitterRecordKey(
  pluginName: string,
  chainId: ChainId,
  emitterAddress: string,
): string {
  return `${sanitize(pluginName)}:${chainId}:${emitterAddress}`;
}

function parseEmitterRecordKey(key: string): EmitterRecordKey {
  const [pluginName, chainIdStr, emitterAddress] = key.split(":");
  return { pluginName, chainId: Number(chainIdStr) as ChainId, emitterAddress };
}

export class Storage {
  private readonly constants: Record<string, string> = {};
  private readonly plugins: Map<string, Plugin>;
  private readonly logger;

  constructor(
    private readonly store: RedisWrapper,
    plugins: Plugin[],
    private readonly _defaultWorkflowOptions: WorkflowOptions,
    private readonly nodeId: string,
    logger: Logger,
    private readonly namespace: string = "",
  ) {
    this.logger = getScopedLogger([`GlobalStorage`], logger);
    this.plugins = new Map(plugins.map(p => [p.pluginName, p]));
    if (!this.namespace) {
      this.logger.warn(
        "You are starting a relayer without a namespace, which could cause issues if you run multiple relayers using the same Redis instance",
      );
    }
    this.constants = constantsWithNamespace(this.namespace);
  }

  // fetch an emitter record by chainId and emitterAddress
  getEmitterRecord(
    pluginName: string,
    chainId: ChainId,
    emitterAddress: string,
  ): Promise<EmitterRecord | null> {
    return this.store.withRedis(redis => {
      return this.getEmitterRecordInner(
        redis,
        emitterRecordKey(pluginName, chainId, emitterAddress),
      );
    });
  }

  private async getEmitterRecordInner(
    redis: IRedis,
    key: string,
  ): Promise<EmitterRecord | null> {
    const res = await redis.hGet(this.constants.EMITTER_KEY, key);
    if (!res) {
      return null;
    }
    const parsed: EmitterRecord = JSON.parse(res);
    parsed.time = new Date(parsed.time);
    return parsed;
  }

  // set an emitter record with given sequence and update the timestamp
  setEmitterRecord(
    pluginName: string,
    chainId: ChainId,
    emitterAddress: string,
    newLastSeenSequence: number,
  ): Promise<void> {
    return this.store.runOpWithRetry(async redis => {
      const logger = this.logger.child({
        chainId,
        emitterAddress,
        sequence: newLastSeenSequence,
      });
      logger.debug(`Updating emitter record last seen sequence.`);
      while (true) {
        const key = emitterRecordKey(pluginName, chainId, emitterAddress);

        const entry = await this.getEmitterRecordInner(redis, key);

        if (entry) {
          logger.debug(`Found emitterRecord`, {
            lastUpdatedAt: entry.time,
            lastSeenSequence: entry.lastSeenSequence,
          });
          if (entry.lastSeenSequence >= newLastSeenSequence) {
            logger.debug(
              "no need to update if lastSeenSeq has moved past what we are trying to set " +
                key,
              {
                newLastSeenSequence: newLastSeenSequence,
                lastSeenSequence: entry.lastSeenSequence,
              },
            );
            return;
          }
        }

        // only set the record if we are able to aquire the lock
        if (await this.acquireUnsafeLock(redis, key, 50)) {
          const record: EmitterRecord = {
            lastSeenSequence: newLastSeenSequence,
            time: new Date(),
          };
          await redis.hSet(
            this.constants.EMITTER_KEY,
            key,
            JSON.stringify(record),
          );
          await this.releaseUnsafeLock(redis, key);
          logger.debug(
            `Updated emitter record. Key ${key}, ${JSON.stringify(record)}`,
            {
              key: key,
              timestamp: record.time,
              updatedSequence: record.lastSeenSequence,
            },
          );
          return;
        }
        logger.debug("Failed to acquire lock for key, retrying... ", {
          key: key,
        });
      }
    });
  }

  // Fetch all emitter records from redis
  getAllEmitterRecords(): Promise<EmitterRecordWithKey[]> {
    return this.store.withRedis(async redis => {
      const res = await redis.hGetAll(this.constants.EMITTER_KEY);
      this.logger.debug(`getAllEmitterRecords raw: ${JSON.stringify(res)}`);
      return Object.entries(res).map(([key, value]) => {
        const { lastSeenSequence, time }: EmitterRecord = JSON.parse(value);
        return {
          lastSeenSequence,
          time: new Date(time),
          ...parseEmitterRecordKey(key),
        };
      });
    });
  }

  async emitHeartbeat(): Promise<void> {
    return this.store.withRedis(async redis => {
      const now = new Date();
      await redis.hSet(
        this.constants.EXECUTORS_HEARTBEAT_HASH,
        this.nodeId,
        now.toISOString(),
      );
      return;
    });
  }

  get defaultWorkflowOptions() {
    return Object.assign({}, this._defaultWorkflowOptions);
  }

  // Number of active workflows currently being executed
  numActiveWorkflows(): Promise<number> {
    return this.store.withRedis(redis =>
      redis.lLen(this.constants.ACTIVE_WORKFLOWS_QUEUE),
    );
  }

  numEnqueuedWorkflows(): Promise<number> {
    return this.store.withRedis(redis =>
      redis.lLen(this.constants.READY_WORKFLOW_QUEUE),
    );
  }

  numDelayedWorkflows(): Promise<number> {
    return this.store.withRedis(redis =>
      redis.lLen(this.constants.DELAYED_WORKFLOWS_QUEUE),
    );
  }

  numFailedWorkflows(): Promise<number> {
    return this.store.withRedis(redis =>
      redis.lLen(this.constants.DEAD_LETTER_QUEUE),
    );
  }

  async getReadyWorkflows(start: number, end: number): Promise<Workflow[]> {
    return this.getWorkflowsInQueue(
      this.constants.READY_WORKFLOW_QUEUE,
      start,
      end,
    );
  }

  async getCompletedWorkflows(start: number, end: number): Promise<Workflow[]> {
    return this.getWorkflowsInQueue(
      this.constants.COMPLETED_WORKFLOWS_QUEUE,
      start,
      end,
    );
  }

  async getFailedWorkflows(start: number, end: number): Promise<Workflow[]> {
    return this.getWorkflowsInQueue(
      this.constants.DEAD_LETTER_QUEUE,
      start,
      end,
    );
  }

  async getInProgressWorkflows(
    start: number,
    end: number,
  ): Promise<Workflow[]> {
    return this.getWorkflowsInQueue(
      this.constants.ACTIVE_WORKFLOWS_QUEUE,
      start,
      end,
    );
  }

  async getDelayedWorkflows(start: number, end: number): Promise<Workflow[]> {
    return this.getWorkflowsInQueue(
      this.constants.DELAYED_WORKFLOWS_QUEUE,
      start,
      end,
    );
  }

  async moveFailedWorkflowToReady(workflowId: {
    pluginName: string;
    id: string;
  }) {
    const workflowKey = this._workflowKey(workflowId);
    return this.store.withRedis(async redis => {
      // TODO: We need to check if workflow is in progress
      await redis
        .multi()
        .lRem(this.constants.READY_WORKFLOW_QUEUE, 0, workflowKey)
        .zRem(this.constants.DELAYED_WORKFLOWS_QUEUE, workflowKey)
        .lRem(this.constants.DEAD_LETTER_QUEUE, 0, workflowKey)
        .hSet(workflowKey, <SerializedWorkflowKeys>{
          failedAt: "",
          processingBy: "",
          errorMessage: "",
          errorStacktrace: "",
          startedProcessingAt: "",
          retryCount: 0,
          completedAt: "",
        })
        .lPush(this.constants.READY_WORKFLOW_QUEUE, workflowKey)
        .exec(true);
      const raw = await redis.hGetAll(workflowKey);
      return this.rawObjToWorkflow(raw);
    });
  }

  async getWorkflowsInQueue(
    queueName: string,
    start: number,
    end: number,
  ): Promise<Workflow[]> {
    return this.store.withRedis(async redis => {
      const activeWorkflowsIds = await redis.lRange(queueName, start, end);

      const rawWorkflows = await Promise.all(
        activeWorkflowsIds.map(id => redis.hGetAll(id)),
      );
      return rawWorkflows.map(raw => this.rawObjToWorkflow(raw));
    });
  }

  private serializeWorkflow(workflow: Workflow): Record<string, any> {
    const data = JSON.stringify(workflow.data);
    const serialized = JSON.parse(JSON.stringify(workflow));
    serialized.data = data;
    return serialized;
  }

  // Add a workflow to the queue to be processed
  addWorkflow(workflow: Workflow): Promise<void> {
    // set defaults if no values were passed;
    workflow.maxRetries =
      workflow.maxRetries ?? this._defaultWorkflowOptions.maxRetries;

    const key = this._workflowKey(workflow);
    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      if (await redis.exists(key)) {
        await redis.unwatch();
        return;
      }
      workflow.scheduledAt = new Date();
      workflow.scheduledBy = this.nodeId;
      const serializedWorkflow = this.serializeWorkflow(workflow);
      await redis
        .multi()
        .lPush(this.constants.READY_WORKFLOW_QUEUE, key)
        .hSet(key, serializedWorkflow)
        .exec(true);
    });
  }

  // Requeue a workflow to be processed
  async requeueWorkflow(workflow: Workflow, reExecuteAt: Date): Promise<void> {
    const key = this._workflowKey(workflow);

    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      const global = await redis.exists(key);
      let multi = redis.multi();
      if (!global) {
        throw new Error("Trying to requeue workflow that doesn't exist");
      } else if (await redis.hGet(key, "completedAt")) {
        // requeue completed workflow if mistakenly completed
        this.logger.info("requeueing workflow that is marked complete", {
          workflowId: workflow.id,
        });
        multi = multi.hSet(key, <SerializedWorkflowKeys>{ completedAt: "" });
      }
      let op = multi
        .lRem(this.constants.READY_WORKFLOW_QUEUE, 0, key) // ensure key is not present in queue already
        .lRem(this.constants.ACTIVE_WORKFLOWS_QUEUE, 0, key) // remove key from workflow queue if present
        .hSet(key, <SerializedWorkflowKeys>{
          processingBy: "",
          startedProcessingAt: "",
          errorMessage: workflow.errorMessage,
          errorStacktrace: workflow.errorStacktrace,
        })
        .hIncrBy(key, "retryCount", 1);
      op =
        reExecuteAt < new Date()
          ? op.lPush(this.constants.READY_WORKFLOW_QUEUE, key) //if  Add directly to ready workflows
          : op.zAdd(this.constants.DELAYED_WORKFLOWS_QUEUE, [
              { value: key, score: reExecuteAt.getTime() },
            ]); // Add to delayed worfklows
      await op.exec(true);
    });
  }

  // Mark a workflow as complete and remove it from the set of active workflows
  completeWorkflow(workflow: {
    id: WorkflowId;
    pluginName: string;
  }): Promise<void> {
    const key = this._workflowKey(workflow);
    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      if (await redis.hGet(key, "completedAt")) {
        await redis.unwatch();
        return;
      }
      const now = new Date();
      await redis
        .multi()
        .hSet(key, <SerializedWorkflowKeys>{
          completedAt: now.toJSON(),
          processingBy: "",
          startedProcessingAt: "",
          errorMessage: "",
          errorStacktrace: "",
        })
        .lRem(this.constants.ACTIVE_WORKFLOWS_QUEUE, 0, key)
        .lPush(this.constants.COMPLETED_WORKFLOWS_QUEUE, key)
        .lTrim(this.constants.COMPLETED_WORKFLOWS_QUEUE, 0, 100)
        .exec(true);
    });
  }

  failWorkflow(workflow: {
    id: WorkflowId;
    pluginName: string;
    errorMessage?: string;
    errorStacktrace?: string;
  }): Promise<void> {
    const key = this._workflowKey(workflow);
    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      if (await redis.hGet(key, "failedAt")) {
        await redis.unwatch();
        return;
      }
      const now = new Date();
      await redis
        .multi()
        .hSet(key, <Partial<SerializedWorkflowKeys>>{
          failedAt: now.toString(),
          failedMessage: workflow.errorMessage,
          failedStacktrace: workflow.errorStacktrace,
          processingBy: "",
          startedProcessingAt: "",
        })
        .lRem(this.constants.ACTIVE_WORKFLOWS_QUEUE, 0, key)
        .lRem(this.constants.COMPLETED_WORKFLOWS_QUEUE, 0, key)
        .zRem(this.constants.DELAYED_WORKFLOWS_QUEUE, key)
        .lPush(this.constants.DEAD_LETTER_QUEUE, key)
        .exec(true);
    });
  }

  async getWorkflow(workflowId: {
    pluginName: string;
    id: string;
  }): Promise<WorkflowWithPlugin | null> {
    const key = this._workflowKey(workflowId);
    const workflowRaw = await this.store.withRedis(redis => redis.hGetAll(key));
    if (!workflowRaw) {
      return null;
    }
    const workflow = this.rawObjToWorkflow(workflowRaw);
    return { workflow, plugin: nnull(this.plugins.get(workflow.pluginName)) };
  }

  // Get the next workflow to process.
  // Removes the key from the workflow queue and places it in the active workflow set
  async getNextWorkflow(
    timeoutInSeconds: number,
  ): Promise<WorkflowWithPlugin | null> {
    return this.store.withRedis(async redis => {
      const key = await redis.blMove(
        this.constants.READY_WORKFLOW_QUEUE,
        this.constants.ACTIVE_WORKFLOWS_QUEUE,
        Direction.LEFT,
        Direction.RIGHT,
        timeoutInSeconds,
      );
      if (!key) {
        return null;
      }
      const now = new Date();
      await redis.hSet(key, {
        processingBy: this.nodeId,
        startedProcessingAt: now.toISOString(),
      });
      const raw = nnull(await redis.hGetAll(key));
      const workflow = this.rawObjToWorkflow(raw);
      return { workflow, plugin: nnull(this.plugins.get(workflow.pluginName)) };
    });
  }

  private rawObjToWorkflow(raw: Record<string, string>): Workflow {
    return {
      id: raw.id,
      data: JSON.parse(raw.data),
      completedAt: raw.completedAt ? new Date(raw.completedAt) : undefined,
      scheduledAt: raw.scheduledAt ? new Date(raw.scheduledAt) : undefined,
      failedAt: raw.failedAt ? new Date(raw.failedAt) : undefined,
      startedProcessingAt: raw.startedProcessingAt
        ? new Date(raw.startedProcessingAt)
        : undefined,
      scheduledBy: raw.scheduledBy,
      processingBy: raw.processingBy,
      errorMessage: raw.errorMessage,
      errorStacktrace: raw.errorStacktrace,
      pluginName: raw.pluginName,
      retryCount: Number(raw.retryCount),
      maxRetries: Number(raw.maxRetries),
      emitterAddress: raw.emitterAddress,
      emitterChain: Number(raw.emitterChain),
      sequence: raw.sequence,
    };
  }

  getStagingAreaKeyLock(pluginName: string): StagingAreaKeyLock {
    return new DefaultStagingAreaKeyLock(
      this.store,
      this.constants,
      this.logger,
      pluginName,
    );
  }

  // this is a simple lock which under the wrong conditions cannot guarantee exclusivity
  // if we need a better lock we can use redlock (https://redis.io/docs/manual/patterns/distributed-locks/), but that's not needed right now as it's ok for 2 instances to check this queue.
  // the lock is just to avoid duplicated work, not to guarantee exclusivity.
  private async acquireUnsafeLock(
    redis: IRedis,
    key: string,
    expiresInMs: number,
  ): Promise<string | null> {
    const op = async (redis: IRedis) => {
      try {
        const lockKey = `locks:${key}`;
        await redis.watch(lockKey);
        const lockOwner = await redis.get(lockKey);
        // we already own the lock, extend it
        if (lockOwner === this.nodeId) {
          await redis.multi().pExpire(lockKey, expiresInMs).exec();
          return lockKey;
        } else if (lockOwner === null) {
          // no one ownes lock, aquire it
          const didSet = await redis.set(lockKey, this.nodeId, {
            NX: true,
            PX: expiresInMs,
          });
          await redis.unwatch();
          return didSet ? lockKey : null;
        }
        // somebody else owns the lock
        return null;
      } catch (e) {
        this.logger.error(e);
      }
      return null;
    };

    return op(redis);
  }

  private async releaseUnsafeLock(
    redis: IRedis,
    key: string,
  ): Promise<boolean> {
    const op = async (redis: IRedis) => {
      const lockKey = `locks:${key}`;
      await redis.watch(lockKey);
      const holder = await redis.get(lockKey);
      if (holder === this.nodeId) {
        return redis.multi().del(lockKey).exec();
      }
      return 0;
    };

    const lock = await op(redis);
    return Array.isArray(lock) ? lock[0] === 1 : false;
  }

  async moveDelayedWorkflowsToReadyQueue(): Promise<number> {
    try {
      const jobsMoved = await this.store.withRedis(async redis => {
        const lock = await this.acquireUnsafeLock(
          redis,
          this.constants.CHECK_REQUEUED_WORKFLOWS_LOCK,
          100,
        );
        if (!lock) {
          this.logger.debug("could not acquire lock to move workflows");
          return 0;
        }
        await redis.watch(lock);
        const pendingJobs = await redis.zRangeWithScores(
          this.constants.DELAYED_WORKFLOWS_QUEUE,
          0,
          MAX_ACTIVE_WORKFLOWS,
        );
        if (!pendingJobs.length) {
          return 0;
        }
        const now = new Date();
        const readyWorkflows = [];
        for (const { value: workflowName, score: timeInMs } of pendingJobs) {
          const execAt = new Date(timeInMs);
          if (execAt > now) {
            break;
          }
          readyWorkflows.push(workflowName);
        }

        if (!readyWorkflows.length) {
          await redis.unwatch();
          return 0;
        }

        await redis
          .multi()
          .lPush(this.constants.READY_WORKFLOW_QUEUE, readyWorkflows)
          .zRem(this.constants.DELAYED_WORKFLOWS_QUEUE, readyWorkflows)
          .exec();
        return readyWorkflows.length;
      });
      return jobsMoved;
      // we avoid releasing the lock to avoid multiple instances checking redis aggressively, so at most we check 10 times per second.
    } catch (e) {
      this.logger.error(e);
      return 0;
    }
  }

  async cleanupStaleActiveWorkflows(): Promise<number> {
    try {
      const movedWorkflows = await this.store.withRedis(async redis => {
        const lock = await this.acquireUnsafeLock(
          redis,
          this.constants.CHECK_STALE_ACTIVE_WORKFLOWS_LOCK,
          100,
        );
        if (!lock) {
          this.logger.debug(
            "could not acquire lock to cleanup stale active workflows",
          );
          return 0;
        }

        await redis.watch(lock);
        const activeWorkflowsIds = await redis.lRange(
          this.constants.ACTIVE_WORKFLOWS_QUEUE,
          0,
          -1,
        );
        if (!activeWorkflowsIds.length) {
          await redis.unwatch();
          return 0;
        }

        const aMinuteAgo = new Date(Date.now() - 60000);
        const executors = await redis.hGetAll(
          this.constants.EXECUTORS_HEARTBEAT_HASH,
        );
        const deadExecutors: Record<string, boolean> = {};
        for (const executorId of Object.keys(executors)) {
          const lastHeartbeat = new Date(executors[executorId]);
          if (lastHeartbeat < aMinuteAgo) {
            deadExecutors[executorId] = true;
          }
        }

        if (Object.keys(deadExecutors).length === 0) {
          await redis.unwatch();
          return 0;
        }

        let multi = redis.multi();
        for (const key of activeWorkflowsIds) {
          // TODO: READ LESS DATA. You only to read the processingBy field and then set the corresponding metadata.
          multi.hmGet(key, [
            "pluginName",
            "id",
            "processingBy",
            "emitterChain",
            "emitterAddress",
            "sequence",
          ]);
        }
        const rawWorkflows = await multi.exec();
        await redis.watch(lock);
        const activeWorkflows = rawWorkflows.map(
          // @ts-ignore This is a valid array, the type system is wrong.
          ([
            pluginName,
            id,
            processingBy,
            emitterChain,
            emitterAddress,
            sequence,
          ]) => ({
            id,
            pluginName,
            processingBy,
            emitterChain,
            emitterAddress,
            sequence,
          }),
        );
        const staleWorkflows = activeWorkflows.filter(
          workflow =>
            !workflow.processingBy || deadExecutors[workflow.processingBy],
        );
        if (!staleWorkflows.length) {
          await redis.unwatch();
          return 0;
        }

        multi = redis.multi();
        for (const w of staleWorkflows) {
          const key = this._workflowKey(w);
          multi
            .lRem(this.constants.READY_WORKFLOW_QUEUE, 0, key) // ensure key is not present in queue already
            .lRem(this.constants.ACTIVE_WORKFLOWS_QUEUE, 0, key)
            .hSet(key, <SerializedWorkflowKeys>{
              processingBy: "",
              startedProcessingAt: "",
            })
            .hIncrBy(key, "retryCount", 1)
            .lPush(this.constants.READY_WORKFLOW_QUEUE, key);
          this.logger.info(
            "Attempting to move stale workflow back to ready.",
            w,
          );
        }
        await multi.exec();
        // LOG Ids
        const count = staleWorkflows.length;
        this.logger.info(
          `Found ${count} state jobs. Moved them back to ready queue`,
          { count: count },
        );
        return count;
      });
      return movedWorkflows;
    } catch (e) {
      this.logger.error("Error cleaning up stale workflows", e);
      return 0;
    }
  }

  private _workflowKey(workflow: { id: string; pluginName: string }): string {
    return this.namespace
      ? `${this.namespace}/${workflow.pluginName}/${workflow.id}`
      : `${workflow.pluginName}/${workflow.id}`;
  }
}

class DefaultStagingAreaKeyLock implements StagingAreaKeyLock {
  private readonly stagingAreaKey: string;
  constructor(
    private readonly store: RedisWrapper,
    private readonly constants: Record<string, string>,
    readonly logger: Logger,
    pluginName: string,
  ) {
    this.stagingAreaKey = `${this.constants.STAGING_AREA_KEY}/${sanitize(
      pluginName,
    )}`;
  }

  getKeys<KV extends Record<string, any>>(keys: string[]): Promise<KV> {
    return this.store.withRedis(async redis =>
      this.getKeysInternal(redis, keys),
    );
  }

  private getKeysInternal<KV extends Record<string, any>>(
    redis: IRedis,
    keys: string[],
  ): Promise<KV> {
    return Promise.all(
      keys.map(async k => {
        const val = await redis.get(`${this.stagingAreaKey}/${k}`);
        return [k, val !== null ? JSON.parse(val) : undefined];
      }),
    ).then(Object.fromEntries);
  }

  async withKey<T, KV extends Record<string, any>>(
    keys: string[],
    f: (kvs: KV, ctx: OpaqueTx) => Promise<{ newKV: KV; val: T }>,
    tx?: OpaqueTx,
  ): Promise<T> {
    try {
      const op = async (redis: IRedis) => {
        // watch keys so that no other listners can alter
        await redis.watch(keys.map(key => `${this.stagingAreaKey}/${key}`));

        const kvs = await this.getKeysInternal<KV>(redis, keys);

        const { newKV, val } = await f(kvs, { redis } as OpaqueTx);

        let multi = redis.multi();
        for (const [k, v] of Object.entries(newKV)) {
          multi = multi.set(`${this.stagingAreaKey}/${k}`, JSON.stringify(v));
        }
        await multi.exec(true);

        return val;
      };
      return tx
        ? await op((tx as unknown as Tx).redis)
        : this.store.withRedis(op);
    } catch (e) {
      if (e instanceof WatchError) {
        // todo: retry in this case?
        this.logger.warn("Staging area key was mutated while executing");
      } else {
        this.logger.error("Error while reading and writing staging area keys");
      }
      this.logger.error(e);
      throw e;
    }
  }
}

type Tx = { redis: IRedis };
