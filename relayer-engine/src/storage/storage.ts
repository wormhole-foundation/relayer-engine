import { RedisSearchLanguages } from "@node-redis/search/dist/commands";
import { ComputeBudgetInstruction } from "@solana/web3.js";
import { WatchError } from "redis";
import {
  Plugin,
  Workflow,
  WorkflowId,
  StagingAreaKeyLock,
} from "relayer-plugin-interface";
import { error, Logger, warn } from "winston";
import { Storage, RedisWrapper, IRedis } from ".";
import { getScopedLogger, getLogger, dbg } from "../helpers/logHelper";
import { nnull } from "../utils/utils";

const WORKFLOW_ID_COUNTER_KEY = "__workflowIdCounter";
const ACTIVE_WORKFLOWS_KEY = "__activeWorkflows";
const STAGING_AREA_KEY = "__stagingArea";
const WORKFLOW_QUEUE = "__workflowQ";
const COMPLETE = "__complete";
const ACTIVE = "1";

export async function createStorage(
  store: RedisWrapper,
  plugins: Plugin[],
): Promise<Storage> {
  return new DefaultStorage(store, plugins);
}

function sanitize(dirtyString: string): string {
  return dirtyString.replace("[^a-zA-z_0-9]*", "");
}

export class DefaultStorage implements Storage {
  private readonly plugins: Map<string, Plugin>;
  private readonly logger;

  constructor(private readonly store: RedisWrapper, plugins: Plugin[]) {
    this.logger = getScopedLogger([`GlobalStorage`], getLogger());
    this.plugins = new Map(plugins.map(p => [p.pluginName, p]));
  }

  // Number of active workflows currently being executed
  numActiveWorkflows(): Promise<number> {
    return this.store.withRedis(redis => redis.hLen(ACTIVE_WORKFLOWS_KEY));
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
      await redis
        .multi()
        .lPush(WORKFLOW_QUEUE, key)
        .set(key, JSON.stringify(workflow))
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
        .hDel(ACTIVE_WORKFLOWS_KEY, key)
        .exec(true);
    });
  }

  // Get the next workflow to process.
  // Removes the key from the workflow queue and places it in the active workflow set
  async getNextWorkflow(): Promise<null | {
    plugin: Plugin;
    workflow: Workflow;
  }> {
    return this.store.withRedis(async redis => {
      const key = await redis.rPop(WORKFLOW_QUEUE);
      if (!key) {
        return null;
      }
      await redis.hSet(ACTIVE_WORKFLOWS_KEY, key, ACTIVE);
      const raw = dbg(nnull(await redis.get(key)), "workflow to add");
      const workflow = JSON.parse(raw);
      return { workflow, plugin: nnull(this.plugins.get(workflow.pluginName)) };
    });
  }

  // Requeue a workflow to be processed
  // Todo: merge with addWorkflow?
  async requeueWorkflow(workflow: Workflow): Promise<void> {
    const key = workflowKey(workflow);
    this.store.runOpWithRetry(async redis => {
      await redis.watch(key);
      const global = await redis.get(key);
      let multi = redis.multi();
      if (!global) {
        throw new Error("Trying to requeue workflow that doesn't exist");
      } else if (global == COMPLETE) {
        // Should be able to requeue completed workflows if they were mistakenly completed
        this.logger.warn("Trying to requeue workflow that is marked complete");
        multi = multi.set(key, JSON.stringify(workflow));
      }
      multi
        .hDel(ACTIVE_WORKFLOWS_KEY, key)
        .lPush(WORKFLOW_QUEUE, key)
        .exec(true);
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
        const keys = await redis.hKeys(ACTIVE_WORKFLOWS_KEY);

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

  getKeys(keys: string[]): Promise<Record<string, any>> {
    return this.store.withRedis(async redis =>
      this.getKeysInternal(redis, keys),
    );
  }

  private getKeysInternal(
    redis: IRedis,
    keys: string[],
  ): Promise<Record<string, any>> {
    return Promise.all(
      keys.map(async k => {
        const val = await redis.get(k);
        return [k, val ? JSON.parse(val) : undefined];
      }),
    ).then(Object.fromEntries);
  }

  async withKey<T>(
    keys: string[],
    f: (
      kvs: Record<string, any>,
    ) => Promise<{ newKV: Record<string, any>; val: T }>,
  ): Promise<T> {
    this.logger.debug("top of with key");
    try {
      return await this.store.withRedis(async redis => {
        this.logger.debug("inside withRedis");
        await redis.watch(keys.map(key => `${this.stagingAreaKey}/${key}`));
        this.logger.debug("after watch");
        const kvs = await this.getKeysInternal(redis, keys);
        const original = Object.assign({}, kvs);
        this.logger.debug("got keys");
        const { newKV, val } = await f(kvs);
        this.logger.debug("after f(kvs)");
        let multi = redis.multi();
        this.logger.debug("begin multi");
        for (const [k, v] of Object.entries(newKV)) {
          dbg(`${k}, ${v}, ${original[k]}`);
          if (v !== original[k]) {
            multi = multi.set(`${this.stagingAreaKey}/${k}`, JSON.stringify(v));
            this.logger.debug("updating multi");
          }
        }
        await multi.exec(true);
        this.logger.debug("after multi");
        this.logger.debug(val);
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
