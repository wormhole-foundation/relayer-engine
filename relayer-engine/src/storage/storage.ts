import { WatchError } from "redis";
import {
  Plugin,
  StagingAreaKeyLock,
  Workflow,
  WorkflowId,
} from "relayer-plugin-interface";
import { Logger } from "winston";
import {
  Direction,
  InMemory,
  IRedis,
  RedisWrapper,
  Storage,
  WorkflowWithPlugin,
} from ".";
import { CommonEnv, StoreType } from "../config";
import { getLogger, getScopedLogger, dbg } from "../helpers/logHelper";
import { EngineError, nnull, sleep } from "../utils/utils";
import { DefaultRedisWrapper, RedisConfig } from "./redisStore";

const ACTIVE_WORKFLOWS_QUEUE = "__activeWorkflows";
const STAGING_AREA_KEY = "__stagingArea";
const WORKFLOW_QUEUE = "__workflowQ";
const COMPLETE = "__complete";

/* HACK */
const numTimesWorkflowRequeued = new Map<string, number>();

export async function createStorage(
  plugins: Plugin[],
  config: CommonEnv,
  logger?: Logger,
): Promise<Storage> {
  switch (config.storeType) {
    case StoreType.InMemory:
      return new DefaultStorage(new InMemory(), plugins, logger || getLogger());
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
        logger || getLogger(),
      );
    default:
      throw new EngineError("Unrecognized storage type", config.storeType);
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
    logger: Logger,
  ) {
    this.logger = getScopedLogger([`GlobalStorage`], logger);
    this.plugins = new Map(plugins.map(p => [p.pluginName, p]));
  }

  // Number of active workflows currently being executed
  numActiveWorkflows(): Promise<number> {
    return this.store.withRedis(redis => redis.lLen(ACTIVE_WORKFLOWS_QUEUE));
  }

  numEnqueuedWorkflows(): Promise<number> {
    return this.store.withRedis(redis => redis.lLen(WORKFLOW_QUEUE));
  }

  // Add a workflow to the queue to be processed
  addWorkflow(workflow: Workflow): Promise<void> {
    const key = workflowKey(workflow);
    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      if (await redis.get(key)) {
        await redis.unwatch();
        return;
      }
      workflow.scheduledAt = new Date();
      await redis
        .multi()
        .lPush(WORKFLOW_QUEUE, key)
        .set(key, JSON.stringify(workflow))
        .exec(true);
    });
  }

  // Requeue a workflow to be processed
  async requeueWorkflow(workflow: Workflow): Promise<void> {
    const key = workflowKey(workflow);

    // HACK: prevent infinite requeues
    if (numTimesWorkflowRequeued.get(key)! > 2) {
      this.logger.warn("Workflow has been requeued too many times, dropping");
      return;
    }
    const requeueCount = numTimesWorkflowRequeued.get(key) || 0;
    numTimesWorkflowRequeued.set(key, requeueCount + 1);

    return this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      const global = await redis.get(key);
      let multi = redis.multi();
      if (!global) {
        throw new Error("Trying to requeue workflow that doesn't exist");
      } else if (global == COMPLETE) {
        // requeue completed workflow if mistakenly completed
        this.logger.info(
          "requeueing workflow that is marked complete: " + workflow.id,
        );
        multi = multi.set(key, JSON.stringify(workflow));
      }
      await multi
        .lRem(WORKFLOW_QUEUE, 0, key) // ensure key is not present in queue already
        .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key) // remove key from workflow queue if present
        .lPush(WORKFLOW_QUEUE, key) // push key onto queue
        .exec(true);
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
      if ((await redis.get(key)) == COMPLETE) {
        await redis.unwatch();
        return;
      }
      await redis
        .multi()
        .set(key, COMPLETE)
        .lRem(ACTIVE_WORKFLOWS_QUEUE, 0, key)
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
        WORKFLOW_QUEUE,
        ACTIVE_WORKFLOWS_QUEUE,
        Direction.LEFT,
        Direction.RIGHT,
        timeoutInSeconds,
      );
      if (!key) {
        return null;
      }
      const raw = nnull(await redis.get(key));
      const workflow = JSON.parse(raw);
      if (workflow.scheduledAt) {
        workflow.scheduledAt = new Date(workflow.scheduledAt);
      }
      return { workflow, plugin: nnull(this.plugins.get(workflow.pluginName)) };
    });
  }

  // Demote workflows from active set based off plugin config
  async handleStorageStartupConfig(plugins: Plugin[]): Promise<void> {
    this.logger.debug("Handling storage startup config");
    const pluginToShouldDemote = new Map(
      plugins.map(p => [p.pluginName, p.demoteInProgress]),
    );
    this.logger.info("Checking for inProgress workflows to demote on startup");
    try {
      return this.store.withRedis(async redis => {
        const keys = await redis.hKeys(ACTIVE_WORKFLOWS_QUEUE);

        for await (const key of keys) {
          const workflow: Workflow = await redis
            .get(key)
            .then(nnull)
            .then(JSON.parse);
          if (pluginToShouldDemote.get(workflow.pluginName)) {
            await this.requeueWorkflow(workflow);
          }
        }
      });
    } catch (e) {
      this.logger.error(
        "Encountered an error while demoting in progress items at startup.",
      );
      this.logger.error(e);
    }
  }

  getStagingAreaKeyLock(pluginName: string): StagingAreaKeyLock {
    return new DefaultStagingAreaKeyLock(this.store, this.logger, pluginName);
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
