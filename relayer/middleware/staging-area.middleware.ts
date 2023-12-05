import { Logger } from "winston";
import {
  Cluster,
  ClusterNode,
  ClusterOptions,
  Redis,
  RedisOptions,
} from "ioredis";
import { Middleware, Next } from "../compose.middleware.js";
import { Context } from "../context.js";
import { createPool } from "generic-pool";

export interface StagingAreaContext extends Context {
  kv: StagingAreaKeyLock;
}

export type StagingAreaOpts = (
  | {
      redisClusterEndpoints: ClusterNode[];
      redisCluster: ClusterOptions;
    }
  | {}
) & {
  redis?: RedisOptions;
  namespace?: string;
};

export function stagingArea(
  opts: StagingAreaOpts = {},
): Middleware<StagingAreaContext> {
  const options = {
    redis: { host: "localhost", port: 6379 },
    ...opts,
  };

  // TODO: maybe refactor redis pool for all plugins that rely on it.
  const factory = {
    create: async function () {
      const redis =
        "redisCluster" in opts
          ? new Redis.Cluster(opts.redisClusterEndpoints, opts.redisCluster)
          : new Redis(options.redis);
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

  const redisPool = createPool(factory, poolOpts);

  return async function stagingArea(ctx: StagingAreaContext, next: Next) {
    const redis = await redisPool.acquire();

    ctx.kv = new DefaultStagingAreaKeyLock(
      redis,
      opts.namespace ?? "default",
      ctx.logger,
    );
    try {
      ctx.logger?.debug("Staging area attached to context");
      await next();
    } finally {
      await redisPool.release(redis);
    }
  };
}

export interface StagingAreaKeyLock {
  withKey<T, KV extends Record<string, any>>(
    keys: string[],
    f: (kvs: KV, ctx: OpaqueTx) => Promise<{ newKV: KV; val: T }>,
    tx?: OpaqueTx,
  ): Promise<T>;
  getKeys<KV extends Record<string, any>>(keys: string[]): Promise<KV>;
}

export type OpaqueTx = never;

function sanitize(dirtyString: string): string {
  return dirtyString.replace("[^a-zA-z_0-9]*", "");
}

class DefaultStagingAreaKeyLock implements StagingAreaKeyLock {
  private readonly stagingAreaKey: string;

  constructor(
    private readonly redis: Redis | Cluster,
    namespace: string,
    readonly logger?: Logger,
  ) {
    this.stagingAreaKey = `stagingAreas:${sanitize(namespace)}`;
  }

  getKeys<KV extends Record<string, any>>(keys: string[]): Promise<KV> {
    return this.getKeysInternal(this.redis, keys);
  }

  async withKey<T, KV extends Record<string, any>>(
    keys: string[],
    f: (kvs: KV, ctx: OpaqueTx) => Promise<{ newKV: KV; val: T }>,
    tx?: OpaqueTx,
  ): Promise<T> {
    try {
      const op = async (redis: Redis | Cluster) => {
        // watch keys so that no other listners can alter
        await redis.watch(keys.map(key => `${this.stagingAreaKey}/${key}`));

        const kvs = await this.getKeysInternal<KV>(redis, keys);

        const { newKV, val } = await f(kvs, { redis } as OpaqueTx);

        let multi = redis.multi();
        for (const [k, v] of Object.entries(newKV)) {
          multi = multi.set(`${this.stagingAreaKey}/${k}`, JSON.stringify(v));
        }
        await multi.exec();

        return val;
      };
      return tx ? await op((tx as unknown as Tx).redis) : op(this.redis);
    } catch (e) {
      // Figure out how to catch watch error in ioredis
      // if (e instanceof WatchError) {
      //   // todo: retry in this case?
      //   this.logger.warn("Staging area key was mutated while executing");
      // } else {
      //   this.logger.error("Error while reading and writing staging area keys");
      // }
      this.logger?.error(e);
      throw e;
    }
  }

  private getKeysInternal<KV extends Record<string, any>>(
    redis: Redis | Cluster,
    keys: string[],
  ): Promise<KV> {
    return Promise.all(
      keys.map(async k => {
        const val = await redis.get(`${this.stagingAreaKey}/${k}`);
        return [k, val !== null ? JSON.parse(val) : undefined];
      }),
    ).then(Object.fromEntries);
  }
}

type Tx = { redis: Redis };
