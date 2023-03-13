import { Middleware } from "../compose.middleware";
import { RedisOptions } from "ioredis";
import { RelayerApp } from "../application";
import { Logger } from "winston";
export type { RedisOptions };
interface MissedVaaOpts {
    checkForMissedVaasEveryMs?: number;
    wormholeRpcs?: string[];
    namespace: string;
    redis?: RedisOptions;
    logger?: Logger;
}
export declare function missedVaas(app: RelayerApp<any>, opts: MissedVaaOpts): Middleware;
