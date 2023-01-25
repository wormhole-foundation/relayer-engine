"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultRedisWrapper = void 0;
const async_mutex_1 = require("async-mutex");
const redis_1 = require("redis");
const logHelper_1 = require("../helpers/logHelper");
const utils_1 = require("../utils/utils");
class DefaultRedisWrapper {
    redis;
    logger;
    backlog = [];
    mutex = new async_mutex_1.Mutex();
    constructor(redis, logger) {
        this.redis = redis;
        this.logger = logger;
    }
    static async fromConfig(config) {
        const logger = (0, logHelper_1.getScopedLogger)(["DefaultRedisWrapper"]);
        const redis = await createConnection(config, logger);
        return new DefaultRedisWrapper(redis, logger);
    }
    async runOpWithRetry(op) {
        this.backlog.push(op);
        await this.executeBacklog();
    }
    withRedis(op) {
        return this.redis.executeIsolated(op);
    }
    // This process executes the backlog periodically, so that items inside the backlog
    // do not need to wait for a new item to enter the backlog before they can execute again
    // setInterval(executeBacklog, 1000 * 60);
    async executeBacklog() {
        await this.mutex.runExclusive(async () => {
            for (let i = 0; i < this.backlog.length; ++i) {
                try {
                    await this.redis.executeIsolated(this.backlog[i]);
                }
                catch (e) {
                    this.backlog = this.backlog.slice(i);
                    this.logger.error(e);
                    return;
                }
            }
            this.backlog = [];
        });
    }
}
exports.DefaultRedisWrapper = DefaultRedisWrapper;
async function createConnection({ redisHost, redisPort }, logger) {
    try {
        let client = (0, redis_1.createClient)({
            socket: {
                host: redisHost,
                port: redisPort,
            },
        });
        client.on("connect", function (err) {
            if (err) {
                logger.error("connectToRedis: failed to connect to host [" +
                    redisHost +
                    "], port [" +
                    redisPort +
                    "]: %o", err);
            }
        });
        await client.connect();
        return (0, utils_1.nnull)(client);
    }
    catch (e) {
        logger.error("connectToRedis: failed to connect to host [" +
            redisHost +
            "], port [" +
            redisPort +
            "]: %o", e);
        throw new Error("Could not connect to Redis");
    }
}
//The backlog is a FIFO queue of outstanding redis operations
//# sourceMappingURL=redisStore.js.map