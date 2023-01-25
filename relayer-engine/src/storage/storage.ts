import { WatchError } from "redis";
import {
  Plugin,
  StagingAreaKeyLock,
  Workflow,
  WorkflowId,
  WorkflowOptions,
} from "relayer-plugin-interface";
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
import { RedisConfig, RedisWrapper } from "./redisStore";
import { ChainId } from "@certusone/wormhole-sdk";
import { CommonEnv, StoreType } from "../config";

const READY_WORKFLOW_QUEUE = "__workflowQ"; // workflows ready to execute
const ACTIVE_WORKFLOWS_QUEUE = "__activeWorkflows";
const DEAD_LETTER_QUEUE = "__deadWorkflows";
const DELAYED_WORKFLOWS_QUEUE = "__delayedWorkflows"; // failed workflows being delayed before going back to ready to execute
const EXECUTORS_HEARTBEAT_HASH = "__executorsHeartbeats";
const STAGING_AREA_KEY = "__stagingArea";
const CHECK_REQUEUED_WORKFLOWS_LOCK = "__isRequeueJobRunning";
const CHECK_STALE_ACTIVE_WORKFLOWS_LOCK = "_isStaleWorkflowsJobRunning";
const EMITTER_KEY = "__emitter";

type SerializedWorkflowKeys = { [k in keyof Workflow]: string | number };

type CreationArgs = {
  plugins: Plugin[]
  config: CommonEnv
  nodeId: string
  logger: Logger
}

function validateAndGetRedisConfig(config: CommonEnv) {
  const redisConfig = config as RedisConfig;
  if (!redisConfig.redisHost || !redisConfig.redisPort) {
    throw new EngineError(
      "Redis config values must be present if redis store type selected",
    );
  }
  return redisConfig;
}

async function createRedisStorage({ plugins, config, nodeId, logger}: CreationArgs) {
  const redisConfig = validateAndGetRedisConfig(config);
  const { defaultWorkflowOptions, namespace } = config;
  return new Storage(
    await RedisWrapper.fromConfig(redisConfig),
    plugins,
    defaultWorkflowOptions,
    nodeId,
    logger,
    namespace
  );
}

function createInvalidStorage({ config: { storeType } } : CreationArgs) {
  throw new EngineError(`Unrecognized storage type ${storeType}`);
}

function getFactory({ storeType }: CommonEnv, factories = {
  [StoreType.Redis]: createRedisStorage
}) {
  return factories[storeType] || createInvalidStorage;
}

export async function createStorage(
  plugins: Plugin[],
  config: CommonEnv,
  nodeId: string,
  logger: Logger = getLogger(),
): Promise<Storage> {
  const create = getFactory(config);
  return create({ plugins, config, nodeId, logger });
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
  private readonly plugins: Map<string, Plugin>;
  private readonly logger;

  constructor(
    private readonly store: RedisWrapper,
    plugins: Plugin[],
    private readonly _defaultWorkflowOptions: WorkflowOptions,
    private readonly nodeId: string,
    logger: Logger,
    private readonly namespace?: string
  ) {
    this.logger = getScopedLogger([`GlobalStorage`], logger);
    this.plugins = new Map(plugins.map(p => [p.pluginName, p]));
    if (!this.namespace) {
      this.logger.warn('You are starting a relayer without a namespace, which could cause issues if you run multiple relayer over the same Redis instance');
    }
  }

  // fetch an emitter record by chainId and emitterAddress
  getEmitterRecord(
    pluginName: string,
    chainId: ChainId,
    emitterAddress: string,
  ): Promise<EmitterRecord | null> {
    return this.store.withRedis(async redis => {
      return await this.getEmitterRecordInner(
        redis,
        emitterRecordKey(pluginName, chainId, emitterAddress),
      );
    });
  }

  private async getEmitterRecordInner(
    redis: IRedis,
    key: string,
  ): Promise<EmitterRecord | null> {
    const res = await redis.hGet(EMITTER_KEY, key);
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
    lastSeenSequence: number,
  ): Promise<void> {
    return this.store.runOpWithRetry(async redis => {
      this.logger.debug(`setEmitterRecord`);
      while (true) {
        const record: EmitterRecord = { lastSeenSequence, time: new Date() };
        const key = emitterRecordKey(pluginName, chainId, emitterAddress);

        const entry = await this.getEmitterRecordInner(redis, key);
        this.logger.debug(`Got emitterRecord ${JSON.stringify(entry)}`);

        if (entry && entry.lastSeenSequence >= lastSeenSequence) {
          this.logger.debug(
            "no need to update if lastSeenSeq has moved past what we are trying to set " +
              key,
          );
          return;
        }

        // only set the record if we are able to aquire the lock
        if (await this.acquireUnsafeLock(redis, key, 50)) {
          await redis.hSet(EMITTER_KEY, key, JSON.stringify(record));
          await this.releaseUnsafeLock(redis, key);
          this.logger.debug(
            `Updated emitter record. Key ${key}, ${JSON.stringify(record)}`,
          );
          return;
        }
        this.logger.debug("Failed to acquire lock for key, retrying... " + key);
      }
    });
  }

  // Fetch all emitter records from redis
  getAllEmitterRecords(): Promise<EmitterRecordWithKey[]> {
    return this.store.withRedis(async redis => {
      this.logger.debug(`getAllEmitterRecords`);
      const res = await redis.hGetAll(EMITTER_KEY);
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
        EXECUTORS_HEARTBEAT_HASH,
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
    return this.store.withRedis(redis => redis.lLen(ACTIVE_WORKFLOWS_QUEUE));
  }

  numEnqueuedWorkflows(): Promise<number> {
    return this.store.withRedis(redis => redis.lLen(READY_WORKFLOW_QUEUE));
  }

  numDelayedWorkflows(): Promise<number> {
    return this.store.withRedis(redis => redis.lLen(DELAYED_WORKFLOWS_QUEUE));
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
        .lPush(READY_WORKFLOW_QUEUE, key)
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
        this.logger.info(
          "requeueing workflow that is marked complete: " + workflow.id,
        );
        multi = multi.hSet(key, <SerializedWorkflowKeys>{ completedAt: "" });
      }
      let op = await multi
        .lRem(READY_WORKFLOW_QUEUE, 0, key) // ensure key is not present in queue already
        .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key) // remove key from workflow queue if present
        .hSet(key, <SerializedWorkflowKeys>{
          processingBy: "",
          startedProcessingAt: "",
        })
        .hIncrBy(key, "retryCount", 1);
      op =
        reExecuteAt < new Date()
          ? op.lPush(READY_WORKFLOW_QUEUE, key) //if  Add directly to ready workflows
          : op.zAdd(DELAYED_WORKFLOWS_QUEUE, [
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
          completedAt: now.toString(),
          processingBy: "",
          startedProcessingAt: "",
        })
        .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key)
        .exec(true);
    });
  }

  failWorkflow(workflow: {
    id: WorkflowId;
    pluginName: string;
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
        .hSet(key, <SerializedWorkflowKeys>{
          failedAt: now.toString(),
          processingBy: "",
          startedProcessingAt: "",
        })
        .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key)
        .zRem(DELAYED_WORKFLOWS_QUEUE, key)
        .lPush(DEAD_LETTER_QUEUE, key)
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
        READY_WORKFLOW_QUEUE,
        ACTIVE_WORKFLOWS_QUEUE,
        Direction.LEFT,
        Direction.RIGHT,
        timeoutInSeconds,
      );
      if (!key) {
        return null;
      }
      const raw = nnull(await redis.hGetAll(key));
      const workflow = this.rawObjToWorkflow(raw);
      const now = new Date();
      await redis.hSet(key, {
        processingBy: this.nodeId,
        startedProcessingAt: now.getTime(),
      });
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
      pluginName: raw.pluginName,
      retryCount: Number(raw.retryCount),
      maxRetries: Number(raw.maxRetries),
    };
  }

  getStagingAreaKeyLock(pluginName: string): StagingAreaKeyLock {
    return new DefaultStagingAreaKeyLock(this.store, this.logger, pluginName);
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

    return await op(redis);
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
          CHECK_REQUEUED_WORKFLOWS_LOCK,
          100,
        );
        if (!lock) {
          this.logger.debug("could not acquire lock to move workflows");
          return 0;
        }
        await redis.watch(lock);
        const pendingJobs = await redis.zRangeWithScores(
          DELAYED_WORKFLOWS_QUEUE,
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
          .lPush(READY_WORKFLOW_QUEUE, readyWorkflows)
          .zRem(DELAYED_WORKFLOWS_QUEUE, readyWorkflows)
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
          CHECK_STALE_ACTIVE_WORKFLOWS_LOCK,
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
          ACTIVE_WORKFLOWS_QUEUE,
          0,
          -1,
        );
        if (!activeWorkflowsIds.length) {
          await redis.unwatch();
          return 0;
        }

        const aMinuteAgo = new Date(Date.now() - 60000);
        const executors = await redis.hGetAll(EXECUTORS_HEARTBEAT_HASH);
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
          multi.hmGet(key, ["pluginName", "id", "processingBy"]);
        }
        const rawWorkflows = await multi.exec();
        await redis.watch(lock);
        const activeWorkflows = rawWorkflows.map(
          // @ts-ignore This is a valid array, the type system is wrong.
          ([pluginName, id, processingBy]) => ({
            id,
            pluginName,
            processingBy,
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
            .lRem(READY_WORKFLOW_QUEUE, 0, key) // ensure key is not present in queue already
            .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key)
            .hSet(key, <SerializedWorkflowKeys>{
              processingBy: "",
              startedProcessingAt: "",
            })
            .hIncrBy(key, "retryCount", 1)
            .lPush(READY_WORKFLOW_QUEUE, key);
        }
        await multi.exec();
        // LOG Ids
        const count = staleWorkflows.length;
        this.logger.info(
          `Found ${count} state jobs. Moved them back to ready queue`,
        );
        return count;
      });
      return movedWorkflows;
    } catch (e) {
      this.logger.warn(e);
      return 0;
    }
  }

  private _workflowKey(workflow: { id: string; pluginName: string }): string {
    return this.namespace ? `${this.namespace}/${workflow.pluginName}/${workflow.id}` : `${workflow.pluginName}/${workflow.id}`
  }
}

class DefaultStagingAreaKeyLock implements StagingAreaKeyLock {
  private readonly stagingAreaKey: string;
  constructor(
    private readonly store: RedisWrapper,
    readonly logger: Logger,
    pluginName: string,
  ) {
    this.stagingAreaKey = `${STAGING_AREA_KEY}/${sanitize(pluginName)}`;
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
    f: (kvs: KV) => Promise<{ newKV: KV; val: T }>,
  ): Promise<T> {
    try {
      return await this.store.withRedis(async redis => {
        // watch keys so that no other listners can alter
        await redis.watch(keys.map(key => `${this.stagingAreaKey}/${key}`));

        const kvs = await this.getKeysInternal<KV>(redis, keys);

        const { newKV, val } = await f(kvs);

        let multi = redis.multi();
        for (const [k, v] of Object.entries(newKV)) {
          multi = multi.set(`${this.stagingAreaKey}/${k}`, JSON.stringify(v));
        }
        await multi.exec(true);

        return val;
      });
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
