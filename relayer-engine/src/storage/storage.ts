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
  InMemory,
  IRedis,
  RedisWrapper,
  Storage,
  StoreType,
  WorkflowWithPlugin,
} from ".";
import { CommonEnv } from "../config";
import { getLogger, getScopedLogger, dbg } from "../helpers/logHelper";
import { EngineError, nnull, sleep } from "../utils/utils";
import { MAX_ACTIVE_WORKFLOWS } from "../executor/executorHarness";
import { DefaultRedisWrapper, RedisConfig } from "./redisStore";

// QUEUES
const READY_WORKFLOW_QUEUE = "__workflowQ"; // workflows ready to execute
const ACTIVE_WORKFLOWS_QUEUE = "__activeWorkflows"; // workflows currently executing
const DEAD_LETTER_QUEUE = "";
const DELAYED_WORKFLOWS_QUEUE = "__delayedWorkflows"; // failed workflows being delayed before going back to ready to execute
const EXECUTORS_HEARTBEAT_HASH = "__executorsHeartbeats";
const STAGING_AREA_KEY = "__stagingArea";
const COMPLETE = "__complete";
const CHECK_REQUEUED_WORKFLOWS_LOCK = "__isRequeueJobRunning";
const CHECK_STALE_ACTIVE_WORKFLOWS_LOCK = "_isStaleWorkflowsJobRunning";

type SerializedWorkflowKeys = { [k in keyof Workflow]: string | number };

export async function createStorage(
  plugins: Plugin[],
  config: CommonEnv,
  storeType: StoreType = StoreType.InMemory,
  nodeId: string,
  logger?: Logger,
): Promise<Storage> {
  switch (storeType) {
    case StoreType.InMemory:
      return new DefaultStorage(
        new InMemory(),
        plugins,
        config.defaultWorkflowOptions,
        nodeId,
        logger || getLogger(),
      );
    case StoreType.Redis:
      const redisConfig = config as RedisConfig;
      if (!redisConfig.redisHost || !redisConfig.redisPort) {
        throw new EngineError(
          "Redis config values must be present if redis store type selected",
        );
      }
      return new DefaultStorage(
        await DefaultRedisWrapper.fromConfig(redisConfig),
        plugins,
        config.defaultWorkflowOptions,
        nodeId,
        logger || getLogger(),
      );
    default:
      throw new EngineError("Unrecognized storage type", storeType);
  }
}

function sanitize(dirtyString: string): string {
  return dirtyString.replace("[^a-zA-z_0-9]*", "");
}

export class DefaultStorage implements Storage {
  private readonly plugins: Map<string, Plugin>;
  private readonly logger;

  constructor(
    private readonly store: RedisWrapper,
    plugins: Plugin[],
    private readonly _defaultWorkflowOptions: WorkflowOptions,
    private readonly nodeId: string,
    logger: Logger,
  ) {
    this.logger = getScopedLogger([`GlobalStorage`], logger);
    this.plugins = new Map(plugins.map(p => [p.pluginName, p]));
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
  addWorkflow(
    workflow: Workflow,
    workflowOptions: WorkflowOptions = this.defaultWorkflowOptions,
  ): Promise<void> {
    // set defaults if no values were passed;
    workflowOptions.maxRetries =
      workflowOptions.maxRetries ?? this._defaultWorkflowOptions.maxRetries;

    const key = workflowKey(workflow);
    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      if (await redis.get(key)) {
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
    const key = workflowKey(workflow);

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
    const key = workflowKey(workflow);
    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      if (await redis.hGet(key, "completedAt")) {
        await redis.unwatch();
        return;
      }
      const now = new Date();
      await redis
        .multi()
        .hSet(key, <SerializedWorkflowKeys>{ completedAt: now.toString() })
        .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key)
        .exec(true);
    });
  }

  failWorkflow(workflow: {
    id: WorkflowId;
    pluginName: string;
  }): Promise<void> {
    const key = workflowKey(workflow);
    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      if (await redis.hGet(key, "failedAt")) {
        await redis.unwatch();
        return;
      }
      const now = new Date();
      await redis
        .multi()
        .hSet(key, <SerializedWorkflowKeys>{ failedAt: now.toString() })
        .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key)
        .zRem(DELAYED_WORKFLOWS_QUEUE, key)
        .lPush(DEAD_LETTER_QUEUE, key)
        .exec(true);
    });
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

  // Demote workflows from active set based off plugin config
  async handleStorageStartupConfig(plugins: Plugin[]): Promise<void> {
    this.logger.debug("Handling storage startup config");
    const pluginToShouldDemote = new Map(
      plugins.map(p => [p.pluginName, p.demoteInProgress]),
    );
    this.logger.info("Checking for inProgress workflows to demote on startup");
    // try {
    //   return this.store.withRedis(async redis => {
    //     const keys = await redis.hKeys(ACTIVE_WORKFLOWS_QUEUE);
    //
    //     for await (const key of keys) {
    //       const workflow: Workflow = await redis
    //         .get(key)
    //         .then(nnull)
    //         .then(JSON.parse);
    //       if (pluginToShouldDemote.get(workflow.pluginName)) {
    //         await this.requeueWorkflow(workflow, new Date());
    //       }
    //     }
    //   });
    // } catch (e) {
    //   this.logger.error(
    //     "Encountered an error while demoting in progress items at startup.",
    //   );
    //   this.logger.error(e);
    // }
  }

  getStagingAreaKeyLock(pluginName: string): StagingAreaKeyLock {
    return new DefaultStagingAreaKeyLock(this.store, this.logger, pluginName);
  }

  // this is a simple lock which under the wrong conditions cannot guarantee exclusivity
  // if we need a better lock we can use redlock (https://redis.io/docs/manual/patterns/distributed-locks/), but that's not needed right now as it's ok for 2 instances to check this queue.
  // the lock is just to avoid duplicated work, not to guarantee exclusivity.
  private async acquireUnsafeLock(
    key: string,
    expiresInMs: number,
  ): Promise<string | null> {
    const lockKey = `locks:${key}`;

    const acquired = await this.store.withRedis(async redis => {
      try {
        await redis.watch(lockKey);
        const lockOwner = await redis.get(lockKey);
        // we already own the lock, extend it
        if (lockOwner === this.nodeId) {
          await redis.multi().pExpire(lockKey, expiresInMs).exec();
          return lockKey;
        } else if (!lockOwner) {
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
    });

    return acquired;
  }

  private async releaseUnsafeLock(key: string): Promise<boolean> {
    const lockKey = `locks:${key}`;
    const lock = await this.store.withRedis(async redis => {
      await redis.watch(lockKey);
      const holder = await redis.get(lockKey);
      if (holder === this.nodeId) {
        return redis.multi().del(lockKey).exec();
      }
      return 0;
    });
    return Array.isArray(lock) ? lock[0] === 1 : false;
  }

  async moveWorkflowsToReadyQueue(): Promise<number> {
    const lock = await this.acquireUnsafeLock(
      CHECK_REQUEUED_WORKFLOWS_LOCK,
      100,
    );
    if (!lock) {
      this.logger.debug("could not acquire lock to move workflows");
      return 0;
    }
    try {
      const jobsMoved = await this.store.withRedis(async redis => {
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
    const lock = await this.acquireUnsafeLock(
      CHECK_STALE_ACTIVE_WORKFLOWS_LOCK,
      100,
    );
    if (!lock) {
      this.logger.debug(
        "could not acquire lock to cleanup stale active workflows",
      );
      return 0;
    }
    const movedWorkflows = await this.store.withRedis(async redis => {
      const activeWorkflowsIds = await redis.lRange(
        ACTIVE_WORKFLOWS_QUEUE,
        0,
        -1,
      );
      if (!activeWorkflowsIds.length) {
        return 0;
      }

      const now = new Date();
      const aMinuteAgo = new Date(now.getTime() - 60000);
      const executors = await redis.hGetAll(EXECUTORS_HEARTBEAT_HASH);
      const deadExecutors: Record<string, boolean> = {};
      for (const executorId of Object.keys(executors)) {
        const lastHeartbeat = new Date(executors[executorId]);
        if (lastHeartbeat < aMinuteAgo) {
          deadExecutors[executorId] = true;
        }
      }

      const multi = redis.multi();
      for (const key of activeWorkflowsIds) {
        multi.hGetAll(key);
      }
      const rawWorkflows = await multi.exec();
      const activeWorkflows = rawWorkflows.map(raw =>
        // @ts-ignore
        this.rawObjToWorkflow(raw),
      );
      const staleWorkflows = activeWorkflows.filter(
        workflow =>
          !workflow.processingBy || deadExecutors[workflow.processingBy],
      );

      return 0;
    });
    return movedWorkflows;
  }
}

function workflowKey(workflow: { id: string; pluginName: string }): string {
  return `${workflow.pluginName}/${workflow.id}`;
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
        // const original = Object.assign({}, kvs);

        const { newKV, val } = await f(kvs);

        // update only those keys that returned and were different than before
        let multi = redis.multi();
        for (const [k, v] of Object.entries(newKV)) {
          // todo: consider checking for changes
          // if (v !== original[k]) {
          multi = multi.set(`${this.stagingAreaKey}/${k}`, JSON.stringify(v));
          // }
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
