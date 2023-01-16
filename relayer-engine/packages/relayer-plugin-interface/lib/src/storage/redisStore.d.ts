import { Logger } from "winston";
import { IRedis, WriteOp, RedisWrapper, Op } from ".";
export interface RedisConfig {
    redisHost: string;
    redisPort: number;
}
export declare class DefaultRedisWrapper implements RedisWrapper {
    readonly redis: IRedis;
    readonly logger: Logger;
    private backlog;
    private mutex;
    constructor(redis: IRedis, logger: Logger);
    static fromConfig(config: RedisConfig): Promise<RedisWrapper>;
    runOpWithRetry(op: WriteOp): Promise<void>;
    withRedis<T>(op: Op<T>): Promise<T>;
    executeBacklog(): Promise<void>;
}
