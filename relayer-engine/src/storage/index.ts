import { RedisClientType } from "redis";
import { Plugin, Workflow } from "../../packages/relayer-plugin-interface";
import { RedisCommandRawReply } from "@node-redis/client/dist/lib/commands";
import { ChainId } from "@certusone/wormhole-sdk";

export { Storage, createStorage } from "./storage";

export type WorkflowWithPlugin = { plugin: Plugin; workflow: Workflow };

// emitter record types
export type EmitterRecord = {
  lastSeenSequence: number;
  time: Date;
};
export type EmitterRecordKey = {
  emitterAddress: string;
  chainId: ChainId;
  pluginName: string;
};
export type EmitterRecordWithKey = EmitterRecord & EmitterRecordKey;

export enum Direction {
  LEFT = "LEFT",
  RIGHT = "RIGHT",
}

export type HSETObject = Record<string | number, string | number>;

type Opts = {
  NX: true | undefined;
  PX: number;
};
// todo: turn this into simpler interface
// export type IRedis = RedisClientType;
export interface IRedis {
  multi(): Multi;
  watch(key: string | string[]): Promise<string>;
  get(key: string): Promise<string | null>;
  exists(key: string): Promise<number>;
  del(key: string): Promise<number>;
  set(key: string, value: string, options?: Opts): Promise<string | null>;
  unwatch(): Promise<string>;
  hLen(key: string): Promise<number>;
  hSet(key: string, field: string, val: string): Promise<number>;
  hSet(key: string, fields: HSETObject): Promise<number>;
  zRem(key: string, element: string | string[]): Promise<number>;
  hIncrBy(key: string, field: string, incr: number): Promise<number>;
  hGet(key: string, field: string): Promise<string | undefined>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hmGet(key: string, keys: string[]): Promise<(string | null)[]>;
  rPop(key: string): Promise<string | null>;
  lPush(key: string, val: string | string[]): Promise<number>;
  lLen(key: string): Promise<number>;
  lRange(key: string, start: number, end: number): Promise<string[]>;
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
  pExpire(key: string, ms: number): Promise<boolean>;
  zRangeWithScores(
    key: string,
    start: number,
    end: number,
  ): Promise<{ value: string; score: number }[]>;
  zAdd(
    key: string,
    elements: { value: string; score: number }[],
  ): Promise<number>;
  duplicate(): IRedis;
  select(db: number): Promise<void>;
  executeIsolated<T>(fn: (redis: IRedis) => Promise<T>): Promise<T>;
}

export interface Multi {
  hDel(key: string, field: string): Multi;
  del(key: string): Multi;
  exists(keys: string): Multi;
  lPush(key: string, element: string | string[]): Multi;
  lTrim(key: string, start: number, end: number): Multi;
  zAdd(key: string, elements: { value: string; score: number }[]): Multi;
  lRem(key: string, count: number, element: string): Multi;
  zRem(key: string, element: string | string[]): Multi;
  set(key: string, value: string): Multi;
  hSet(key: string, field: string, val: string): Multi;
  hSet(key: string, fields: HSETObject): Multi;
  hIncrBy(key: string, field: string, incr: number): Multi;
  hGet(key: string, field: string): Multi;
  hGetAll(key: string): Multi;
  hmGet(key: string, keys: string[]): Multi;
  pExpire(key: string, ms: number): Multi;
  exec(pipeline?: boolean): Promise<RedisCommandRawReply[]>;
}

export type WriteOp = (redis: IRedis) => Promise<void>;
export type Op<T> = (redis: IRedis) => Promise<T>;
// ensure IRedis is subset of real client
const _: IRedis = {} as RedisClientType;
// const x = {} as RedisClientType;
