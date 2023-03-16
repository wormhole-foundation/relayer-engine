import { ClusterNode, ClusterOptions, RedisOptions } from "ioredis";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
export interface StagingAreaContext extends Context {
    kv: StagingAreaKeyLock;
}
export interface StagingAreaOpts {
    redisClusterEndpoints?: ClusterNode[];
    redisCluster?: ClusterOptions;
    redis?: RedisOptions;
    namespace?: string;
}
export declare function stagingArea(opts?: StagingAreaOpts): Middleware<StagingAreaContext>;
export interface StagingAreaKeyLock {
    withKey<T, KV extends Record<string, any>>(keys: string[], f: (kvs: KV, ctx: OpaqueTx) => Promise<{
        newKV: KV;
        val: T;
    }>, tx?: OpaqueTx): Promise<T>;
    getKeys<KV extends Record<string, any>>(keys: string[]): Promise<KV>;
}
export type OpaqueTx = never;
