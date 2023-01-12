import { RedisClientType } from "redis";
import {
  Plugin,
  StagingArea,
  StagingAreaKeyLock,
  Workflow,
  WorkflowId,
} from "relayer-plugin-interface";
import { RedisCommandRawReply } from "@node-redis/client/dist/lib/commands";

export { InMemory } from "./inMemoryStore";
export { createStorage } from "./storage";

export type WorkflowWithPlugin = { plugin: Plugin; workflow: Workflow };

// Idea is we could have multiple implementations backed by different types of storage
// i.e. RedisStorage, PostgresStorage, MemoryStorage etc.
export interface Storage {
  getNextWorkflow(timeoutInSeconds: number): Promise<null | WorkflowWithPlugin>;
  requeueWorkflow(workflow: Workflow): Promise<void>;
  handleStorageStartupConfig(plugins: Plugin[]): Promise<void>;
  numActiveWorkflows(): Promise<number>;
  numEnqueuedWorkflows(): Promise<number>;
  completeWorkflow(workflow: {
    id: WorkflowId;
    pluginName: string;
  }): Promise<void>;
  addWorkflow(workflow: Workflow): Promise<void>;

  getStagingAreaKeyLock(pluginName: string): StagingAreaKeyLock;
}

export enum Direction {
  LEFT = "LEFT",
  RIGHT = "RIGHT",
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
  lLen(key: string): Promise<number>;
  lIndex(key: string, ix: number): Promise<string | null>;
  blMove(
    source: string,
    destination: string,
    sourceDirection: Direction,
    destinationDirection: Direction,
    timeout: number,
  ): Promise<string | null>;
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

export type WriteOp = (redis: IRedis) => Promise<void>;
export type Op<T> = (redis: IRedis) => Promise<T>;
// ensure IRedis is subset of real client
const _: IRedis = {} as RedisClientType;
// const x = {} as RedisClientType;

export interface RedisWrapper {
  runOpWithRetry(op: WriteOp): Promise<void>;
  withRedis<T>(op: Op<T>): Promise<T>;
}
