import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import { Middleware, Next } from "../../compose.middleware";
import { Context } from "../../context";
import Redis, { Cluster, RedisOptions } from "ioredis";
import {
  defaultWormholeRpcs,
  ParsedVaaWithBytes,
  RelayerApp,
  RelayerEvents,
} from "../../application";
import { Logger } from "winston";
import { createPool, Pool } from "generic-pool";
import { mapConcurrent, minute, sleep } from "../../utils";
import { RedisConnectionOpts } from "../../storage/redis-storage";

const IN_PROGRESS_TIMEOUT = 5 * minute;

export type { RedisOptions };
export interface BackgroundJobOpts extends RedisConnectionOpts {
  runEveryMs?: number;
  runFunction?: (queueJob: (job: any) => Promise<void>) => Promise<void>; // TODO better type on the context arg
  jobName?: string;
  namespace?: string;
  logger?: Logger;
}

export function backgroundJob(
  app: RelayerApp<any>,
  opts: BackgroundJobOpts,
): Middleware {
  // set defaults
  opts.redis = opts.redis || { host: "localhost", port: 6379 };
  opts.redis.keyPrefix = opts.namespace;
  const runEveryMs = opts.runEveryMs || 30_000;

  const redisPool = createRedisPool(opts);

  // start worker
  setTimeout(() => startBackgroundJobWorker(redisPool, app, opts), runEveryMs); // start worker once config is done.

  // return noop middleware
  return async (ctx: Context, next) => next();
}

// Background job to ensure no vaas are missed
async function startBackgroundJobWorker(
  pool: Pool<Cluster | Redis>,
  app: RelayerApp<any>,
  opts: BackgroundJobOpts,
) {
  const logger = opts.logger || console;
  const runEveryMs = opts.runEveryMs || 30_000;
  const runFunction = opts.runFunction || (() => {});
  const jobName = opts.jobName || "backgroundJob";

  const queueJob = async (job: any) => {
    //TODO queue up jobs in redis.
  };

  logger.info(`Starting ${jobName} worker.`);

  await runFunction(queueJob);

  // push jobs through VAA process?
}

/*
 * Utils
 */

export function createRedisPool(
  opts: RedisConnectionOpts,
): Pool<Redis | Cluster> {
  const factory = {
    create: async function () {
      const redis = opts.redisCluster
        ? new Redis.Cluster(opts.redisClusterEndpoints, opts.redisCluster)
        : new Redis(opts.redis);
      return redis;
    },
    destroy: async function (redis: Redis | Cluster) {
      // do something when destroyed?
    },
  };
  const poolOpts = {
    min: 5,
    max: 15,
    autostart: true,
  };
  return createPool(factory, poolOpts);
}
