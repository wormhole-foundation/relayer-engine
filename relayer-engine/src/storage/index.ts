import {
  Plugin,
  StagingArea,
  Workflow,
  WorkflowId,
} from "relayer-plugin-interface";
import { DefaultStorage } from "./storage";

export {InMemoryStore} from './inMemoryStore'
export {createStorage} from './storage'

export interface PluginStorageFactory {
  getPluginStorage(plugin: Plugin): PluginStorage;
}

// Idea is we could have multiple implementations backed by different types of storage
// i.e. RedisStorage, PostgresStorage, MemoryStorage etc.
export interface Storage extends PluginStorageFactory {
  getNextWorkflow(
    plugins: Plugin[]
  ): Promise<null | { plugin: Plugin; workflow: Workflow }>;
  completeWorkflow(workflowId: WorkflowId): Promise<boolean>;
  requeueWorkflow(workflow: Workflow): Promise<void>;
  handleStorageStartupConfig(plugins: Plugin[]): Promise<void>;
}

export interface PluginStorage {
  readonly plugin: Plugin;
  getStagingArea(): Promise<StagingArea>;
  saveStagingArea(update: StagingArea): Promise<void>;
  addWorkflow(data: Object): Promise<void>;
}

export interface KVStore<V> {
  keys(): Promise<AsyncIterable<string>>;
  set(key: string, value: V): Promise<void>;
  get(key: string): Promise<V | undefined>;
  delete(key: string): Promise<boolean>;
  compareAndSwap(
    key: string,
    expectedValue: V | undefined,
    newValue: V
  ): Promise<boolean>;
}

export interface QueueStore<T> {
  push(value: T): Promise<void>;
  pop(): Promise<T>;
  length(): Promise<number>;
}

export interface Store {
  kv<V>(prefix?: string): KVStore<V>;
  queue<Q>(prefix?: string): QueueStore<Q>;
}

// export async function createRedisStorage(
//   store: Store,
//   plugins: Plugin[]
// ): Promise<Storage> {
//   await RedisHelper.ensureClient();
//   return new DefaultStorage(RedisHelper, plugins);
// }
