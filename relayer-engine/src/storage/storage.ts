import { Plugin, Workflow, StagingArea } from "relayer-plugin-interface";
import { Storage, Store, PluginStorage } from ".";
import { getScopedLogger, getLogger } from "../helpers/logHelper";
import { nnull } from "../utils/utils";

const WORKFLOW_ID_COUNTER_KEY = "__workflowIdCounter";
const ACTIVE_WORKFLOWS_KEY = "__activeWorkflows";
const STAGING_AREA_KEY = "__stagingArea";

export async function createStorage(
  store: Store,
  plugins: Plugin[]
): Promise<Storage> {
  return new DefaultStorage(store, plugins);
}

function sanitize(dirtyString: string): string {
  return dirtyString.replace("[^a-zA-z_0-9]*", "");
}

function stagingAreaKey(plugin: Plugin): string {
  return sanitize(plugin.pluginName);
}

export class DefaultStorage implements Storage {
  private readonly plugins: Map<string, Plugin>;
  private readonly logger;
  constructor(private readonly store: Store, plugins: Plugin[]) {
    this.logger = getScopedLogger([`GlobalStorage`], getLogger());
    this.plugins = new Map(plugins.map((p) => [p.pluginName, p]));
  }

  async getNextWorkflow(): Promise<null | {
    plugin: Plugin;
    workflow: Workflow;
  }> {
    const workflow = await this.store.queue<Workflow>().pop();
    if (!workflow) {
      return null;
    }
    // sanity check it's not already in active workflows
    await this.store
      .kv<Workflow>("activeWorkflows")
      .compareAndSwap(workflow.id.toString(), undefined, workflow);
    const plugin = nnull(this.plugins.get(workflow.pluginName));
    return { plugin, workflow };
  }
  completeWorkflow(workflowId: number): Promise<boolean> {
    return this.store
      .kv<Workflow>(ACTIVE_WORKFLOWS_KEY)
      .delete(workflowId.toString());
  }
  async requeueWorkflow(workflow: Workflow): Promise<void> {
    await this.store
      .kv<Workflow>(ACTIVE_WORKFLOWS_KEY)
      .delete(workflow.id.toString());
    await this.store.queue<Workflow>().push(workflow);
  }

  async handleStorageStartupConfig(plugins: Plugin[]): Promise<void> {
    this.logger.debug("Handling storage startup config");
    const pluginToShouldDemote = new Map(
      plugins.map((p) => [p.pluginName, p.demoteInProgress])
    );
    this.logger.info("Checking for inProgress workflows to demote on startup");
    try {
      const kv = this.store.kv<Workflow>(ACTIVE_WORKFLOWS_KEY);
      const keys = await kv.keys();
      for await (const key of keys) {
        const workflow = await kv.get(key).then(nnull);
        if (pluginToShouldDemote.get(workflow.pluginName)) {
          await kv.delete(key);
          await this.store.queue<Workflow>().push(workflow);
        }
      }
    } catch (e) {
      this.logger.error(
        "Encountered an error while demoting in progress items at startup."
      );
      this.logger.error(e);
    }
  }
  getPluginStorage(plugin: Plugin): DefaultPluginStorage {
    return new DefaultPluginStorage(this.store, plugin);
  }
}

class DefaultPluginStorage implements PluginStorage {
  private readonly logger;
  constructor(private readonly store: Store, readonly plugin: Plugin) {
    this.logger = getScopedLogger(
      [`RedisPluginStorage ${plugin.pluginName}`],
      getLogger()
    );
  }
  async addWorkflow(data: Object): Promise<void> {
    const id_from_store = (await this.store
      .kv()
      .get(WORKFLOW_ID_COUNTER_KEY)) as number;
    const workflow: Workflow = {
      data,
      id: id_from_store ? id_from_store : 0,
      pluginName: this.plugin.pluginName,
    };
    await this.store
      .kv()
      .compareAndSwap(WORKFLOW_ID_COUNTER_KEY, workflow.id, workflow.id + 1);
    await this.store.queue<Workflow>().push(workflow);
  }

  async getStagingArea(this: DefaultPluginStorage): Promise<Object> {
    const key = stagingAreaKey(this.plugin);
    const stagingArea = await this.store
      .kv<StagingArea>(STAGING_AREA_KEY)
      .get(key);
    if (!stagingArea) {
      this.logger.warn(
        `Missing staging area for plugin ${this.plugin.pluginName}. Returning empty object`
      );
      return {};
    }
    return stagingArea;
  }

  saveStagingArea(
    this: DefaultPluginStorage,
    newStagingArea: Object
  ): Promise<void> {
    return this.store
      .kv<StagingArea>(STAGING_AREA_KEY)
      .set(stagingAreaKey(this.plugin), newStagingArea);
  }
}
