import { Middleware } from "../compose.middleware";
import { ClusterNode, ClusterOptions, RedisOptions } from "ioredis";
import { RelayerApp } from "../application";
import { Logger } from "winston";
export type { RedisOptions };
interface MissedVaaOpts {
    redisClusterEndpoints?: ClusterNode[];
    redisCluster?: ClusterOptions;
    redis?: RedisOptions;
    checkForMissedVaasEveryMs?: number;
    wormholeRpcs?: string[];
    namespace: string;
    logger?: Logger;
}
export declare function missedVaas(app: RelayerApp<any>, opts: MissedVaaOpts): Middleware;
