import { RedisClientType } from "redis";
import {
  Plugin,
  StagingAreaKeyLock,
  Workflow,
  WorkflowId,
} from "relayer-plugin-interface";

export { InMemory } from "./inMemoryStore";
export { createStorage } from "./storage";

// Idea is we could have multiple implementations backed by different types of storage
// i.e. RedisStorage, PostgresStorage, MemoryStorage etc.
export interface Storage {
  getNextWorkflow(): Promise<null | { plugin: Plugin; workflow: Workflow }>;
  requeueWorkflow(workflow: Workflow): Promise<void>;
  handleStorageStartupConfig(plugins: Plugin[]): Promise<void>;
  numActiveWorkflows(): Promise<number>;
  completeWorkflow(workflow: {
    id: WorkflowId;
    pluginName: string;
  }): Promise<void>;
  addWorkflow(workflow: Workflow): Promise<void>;

  getStagingAreaKeyLock(pluginName: string): StagingAreaKeyLock;
}

// todo: turn this into simpler interface
// export type IRedis = RedisClientType;
export interface IRedis {
  multi(): Multi;
  watch(key: string | string[]): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  unwatch(): Promise<string>;
  hLen(key: string): Promise<number>;
  hSet(key: string, field: string, val: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | undefined>;
  rPop(key: string): Promise<string | null>;
  lPush(key: string, val: string): Promise<number>;
  lRem(key: string, count: number, element: string): Promise<number>;
  hDel(key: string, field: string): Promise<number>;
  hKeys(key: string): Promise<string[]>;
  executeIsolated<T>(fn: (redis: IRedis) => Promise<T>): Promise<T>;
}

export interface Multi {
  hDel(key: string, field: string): Multi;
  lPush(key: string, element: string): Multi;
  lRem(key: string, count: number, element: string): Multi;
  set(key: string, value: string): Multi;
  exec(pipeline?: boolean): Promise<RedisCommandRawReply[]>;
}

export type RedisCommandRawReply =
  | string
  | number
  | Buffer
  | Array<RedisCommandRawReply>
  | null
  | undefined;

export type WriteOp = (redis: IRedis) => Promise<void>;
export type Op<T> = (redis: IRedis) => Promise<T>;
// ensure IRedis is subset of real client
// const _: IRedis = {} as RedisClientType;
const x = {} as RedisClientType;

export interface RedisWrapper {
  runOpWithRetry(op: WriteOp): Promise<void>;
  withRedis<T>(op: Op<T>): Promise<T>;
}
