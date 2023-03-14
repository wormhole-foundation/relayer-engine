"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stagingArea = void 0;
const ioredis_1 = require("ioredis");
const generic_pool_1 = require("generic-pool");
function stagingArea(opts) {
    if (!opts.redis && !opts.redisCluster) {
        throw new Error("You need to pass in redis config");
    }
    // TODO: maybe refactor redis pool for all plugins that rely on it.
    const factory = {
        create: async function () {
            const redis = opts.redisCluster
                ? new ioredis_1.Redis.Cluster(opts.redisCluster, opts.redis)
                : new ioredis_1.Redis(opts.redis);
            return redis;
        },
        destroy: async function () {
            // do something when destroyed?
        },
    };
    const poolOpts = {
        min: 5,
        max: 10,
        autostart: true,
    };
    const redisPool = (0, generic_pool_1.createPool)(factory, poolOpts);
    return async function stagingArea(ctx, next) {
        const redis = await redisPool.acquire();
        ctx.kv = new DefaultStagingAreaKeyLock(redis, ctx.logger, opts.namespace ?? "default");
        try {
            await next();
        }
        finally {
            await redisPool.release(redis);
        }
    };
}
exports.stagingArea = stagingArea;
function sanitize(dirtyString) {
    return dirtyString.replace("[^a-zA-z_0-9]*", "");
}
class DefaultStagingAreaKeyLock {
    redis;
    logger;
    stagingAreaKey;
    constructor(redis, logger, namespace) {
        this.redis = redis;
        this.logger = logger;
        this.stagingAreaKey = `stagingAreas:${sanitize(namespace)}`;
    }
    getKeys(keys) {
        return this.getKeysInternal(this.redis, keys);
    }
    getKeysInternal(redis, keys) {
        return Promise.all(keys.map(async (k) => {
            const val = await redis.get(`${this.stagingAreaKey}/${k}`);
            return [k, val !== null ? JSON.parse(val) : undefined];
        })).then(Object.fromEntries);
    }
    async withKey(keys, f, tx) {
        try {
            const op = async (redis) => {
                // watch keys so that no other listners can alter
                await redis.watch(keys.map((key) => `${this.stagingAreaKey}/${key}`));
                const kvs = await this.getKeysInternal(redis, keys);
                const { newKV, val } = await f(kvs, { redis });
                let multi = redis.multi();
                for (const [k, v] of Object.entries(newKV)) {
                    multi = multi.set(`${this.stagingAreaKey}/${k}`, JSON.stringify(v));
                }
                await multi.exec();
                return val;
            };
            return tx ? await op(tx.redis) : op(this.redis);
        }
        catch (e) {
            // Figure out how to catch wath error in ioredis
            // if (e instanceof WatchError) {
            //   // todo: retry in this case?
            //   this.logger.warn("Staging area key was mutated while executing");
            // } else {
            //   this.logger.error("Error while reading and writing staging area keys");
            // }
            this.logger.error(e);
            throw e;
        }
    }
}
//# sourceMappingURL=staging-area.middleware.js.map