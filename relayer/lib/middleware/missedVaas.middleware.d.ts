import { Middleware } from "../compose.middleware";
import { ClusterNode, RedisOptions } from "ioredis";
import { RelayerApp } from "../application";
import { Logger } from "winston";
export type { RedisOptions };
interface MissedVaaOpts {
    redisCluster?: ClusterNode[];
    redis?: RedisOptions;
    checkForMissedVaasEveryMs?: number;
    wormholeRpcs?: string[];
    namespace: string;
    logger?: Logger;
}
export declare function missedVaas(app: RelayerApp<any>, opts: MissedVaaOpts): Middleware;
