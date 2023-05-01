import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import Redis, { Cluster, RedisOptions } from "ioredis";
import { ChainId, getSignedVAAWithRetry } from "@certusone/wormhole-sdk";
import {
  defaultWormholeRpcs,
  ParsedVaaWithBytes,
  RelayerApp,
  RelayerEvents,
} from "../application";
import { Logger } from "winston";
import { createPool, Pool } from "generic-pool";
import { dbg, minute, sleep } from "../utils";
import { RedisConnectionOpts } from "../storage/redis-storage";
import { GetSignedVAAResponse } from "@certusone/wormhole-sdk-proto-web/lib/cjs/publicrpc/v1/publicrpc";

const IN_PROGRESS_TIMEOUT = 5 * minute;

export type { RedisOptions };
export interface MissedVaaOpts extends RedisConnectionOpts {
  checkForMissedVaasEveryMs?: number;
  wormholeRpcs?: string[];
  logger?: Logger;
}

export interface VaaKey {
  emitterChain: number;
  emitterAddress: string; // todo: string, wh format
  seq: bigint;
}

type FetchVaaFn = (vaa: VaaKey) => Promise<GetSignedVAAResponse>;
type ProcessVaaFn = (x: Buffer) => Promise<void>;
type TryFetchAndProcessFn = (
  redis: Redis | Cluster,
  vaaKey: VaaKey,
  logger?: Logger,
) => Promise<boolean>;

/**
 * Storage schema
 * chain/emitter -> sortedSet -> seq
 *
 * Job:
 * - requery for missed vaas
 * - query next vaa
 *
 * Middleware
 * - requery for missed vaas since last seen (not all)
 */

export function missedVaas(
  app: RelayerApp<any>,
  opts: MissedVaaOpts,
): Middleware {
  opts.redis = opts.redis || { host: "localhost", port: 6379 };
  opts.redis.keyPrefix = opts.namespace;
  opts.wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[app.env];
  const redisPool = createRedisPool(opts);

  app.addListener(RelayerEvents.Added, (vaa: ParsedVaaWithBytes) => {
    redisPool.use(redis =>
      markProcessed(
        redis,
        {
          emitterAddress: vaa.emitterAddress.toString("hex"),
          emitterChain: vaa.emitterChain,
          seq: vaa.sequence,
        },
        opts.logger,
      ),
    );
  });
  const fetchVaaFn = (vaaKey: VaaKey) => fetchVaa(opts.wormholeRpcs, vaaKey);
  setTimeout(() => startMissedVaaWorker(redisPool, app, fetchVaaFn, opts), 100); // start worker once config is done.
  return middlewareFn(opts, fetchVaaFn, redisPool);
}

function middlewareFn(
  opts: MissedVaaOpts,
  fetchVaa: FetchVaaFn,
  redisPool: Pool<Redis | Cluster>,
): Middleware {
  return async (ctx: Context, next) => {
    const wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[ctx.env];

    let vaa = ctx.vaa;
    if (!vaa) {
      await next();
      return;
    }

    redisPool.use(async redis => {
      const key = (seq: bigint) => ({
        emitterAddress: vaa.emitterAddress.toString("hex"),
        emitterChain: vaa.emitterChain,
        seq,
      });
      const lastSeenSeq = await getLastSeenSeq(
        redis,
        vaa.emitterChain,
        vaa.emitterAddress.toString("hex"),
      );

      if (lastSeenSeq !== null && lastSeenSeq + 1n < vaa.sequence) {
        // possibly missed some vaas
        for (
          let currentSeq = lastSeenSeq;
          currentSeq < vaa.sequence;
          currentSeq++
        ) {
          await tryFetchAndProcess(
            ctx.processVaa.bind(ctx),
            fetchVaa,
            redis,
            key(currentSeq),
          );
        }
      } else {
        ctx.logger?.debug(
          "No missed VAAs detected between this VAA and the last VAA we processed.",
        );
      }
      await markProcessed(redis, key(vaa.sequence), ctx.logger);
    });

    await next(); // <-- process the current vaa
  };
}

// Background job to ensure no vaas are missed
async function startMissedVaaWorker(
  pool: Pool<Cluster | Redis>,
  app: RelayerApp<any>,
  fetchVaaFn: FetchVaaFn,
  opts: {
    logger?: Logger;
    checkForMissedVaasEveryMs?: number;
  },
) {
  while (true) {
    await pool
      .use(redis =>
        missedVaaJob(
          redis,
          app.filters,
          (redis: Redis | Cluster, vaaKey: VaaKey) =>
            tryFetchAndProcess(
              app.processVaa.bind(app),
              fetchVaaFn,
              redis,
              vaaKey,
              opts.logger,
            ),
          opts.logger,
        ),
      )
      .catch(e => opts.logger?.error(`error managing redis pool.`, e));
    await sleep(opts.checkForMissedVaasEveryMs || 30_000);
  }
}

// Job that for each registered (emitterChain, emitterAddress) pair:
// - refetches and processes all sequence numbers not marked seen or in progress since initial sequence
// - looks ahead for unseen sequences
export async function missedVaaJob(
  redis: Redis | Cluster,
  filters: {
    emitterFilter?: {
      chainId?: ChainId;
      emitterAddress?: string;
    };
  }[],
  tryFetchAndProcess: TryFetchAndProcessFn,
  logger?: Logger,
) {
  try {
    logger?.debug(`Checking for missed VAAs.`);
    let addressWithLastSequence = await Promise.all(
      filters
        .map(filter => ({
          emitterChain: filter.emitterFilter.chainId,
          emitterAddress: filter.emitterFilter.emitterAddress,
        }))
        .map(async address => {
          const seenSeqs = await getAllProcessedSeqsInOrder(
            redis,
            address.emitterChain,
            address.emitterAddress,
          );
          return { address, seenSeqs };
        }),
    );

    for (const {
      address: { emitterAddress, emitterChain },
      seenSeqs,
    } of addressWithLastSequence) {
      if (seenSeqs.length === 0) {
        continue;
      }

      // comb over all seenSequences looking for gaps
      // note: seenSequences is in ascending order
      const missing = [] as bigint[];
      let idx = 0;
      let nextSeen = seenSeqs[0];
      for (let seq = seenSeqs[0]; seq < seenSeqs[seenSeqs.length - 1]; seq++) {
        if (seq === nextSeen) {
          nextSeen = seenSeqs[++idx];
          continue;
        }
        missing.push(seq);
        const vaaKey = {
          emitterAddress,
          emitterChain,
          seq: seq,
        };
        await tryFetchAndProcess(redis, vaaKey, logger);
      }

      // look ahead of greatest seen sequence in case the next vaa was missed
      // continue looking ahead until a vaa can't be fetched
      for (let seq = seenSeqs[seenSeqs.length - 1] + 1n; true; seq++) {
        // iterate until fetchVaa throws because we couldn't find a next vaa.
        const vaaKey = {
          emitterAddress,
          emitterChain,
          seq: seq,
        };
        const fetched = await tryFetchAndProcess(redis, vaaKey, logger);
        if (!fetched) {
          break;
        }
        missing.push(vaaKey.seq);
      }

      if (missing.length > 0) {
        logger?.info(`missedVaaWorker found ${missing.length} missed vaas`, {
          emitterAddress,
          emitterChain,
          missedSequences: missing,
        });
      }
    }
  } catch (e) {
    logger?.error(`startMissedVaaWorker loop failed with error`, e);
  }
}

// returns true if fetched and processed
async function tryFetchAndProcess(
  processVaa: ProcessVaaFn,
  fetchVaa: FetchVaaFn,
  redis: Redis | Cluster,
  key: VaaKey,
  logger?: Logger,
): Promise<boolean> {
  try {
    const isInProgress = await fetchIsInProgress(redis, key, logger);
    if (isInProgress) {
      // short circuit is missedVaa middleware has already detected this vaa
      return false;
    }
    const fetchedVaa = await fetchVaa(key);
    logger?.info(
      `Possibly missed a vaa, adding to queue.`,
      vaaKeyReadable(key),
    );

    // before re-triggering middleware, mark key as in progress to avoid recursion
    await markInProgress(redis, key, logger);
    // TODO: should this be await'ed? I think not since this could block for a long time and vaas should processable async
    // push the missed vaa through all the middleware / storage service if used.
    processVaa(Buffer.from(fetchedVaa.vaaBytes)) 
    return true;
  } catch (e) {
    // code 5 means vaa not found in store
    if (e.code !== 5) {
      logger?.error(
        `Could not process missed vaa. Sequence: ${key.seq.toString()}`,
        e,
      );
    }
    return false;
  }
}

/*
 * Storage Helpers
 */

async function markInProgress(
  redis: Redis | Cluster,
  keyObj: VaaKey,
  logger: Logger,
) {
  const key = getInProgressKey(keyObj);
  try {
    await redis
      .multi()
      .set(key, new Date().toString())
      .expire(key, IN_PROGRESS_TIMEOUT)
      .exec();
  } catch (e) {
    logger.error("could not mark sequence seen", e);
  }
}

async function fetchIsInProgress(
  redis: Redis | Cluster,
  keyObj: VaaKey,
  logger: Logger,
): Promise<boolean> {
  const key = getInProgressKey(keyObj);
  try {
    const raw = await redis.get(key);
    if (!raw) {
      return false;
    }
    return new Date(raw).getTime() > Date.now() - IN_PROGRESS_TIMEOUT;
  } catch (e) {
    logger.error("could not mark sequence as in progress", e);
    return false;
  }
}

async function getAllProcessedSeqsInOrder(
  redis: Redis | Cluster,
  emitterChain: number,
  emitterAddress: string,
): Promise<bigint[]> {
  const key = getKey(emitterChain, emitterAddress);
  const results = await redis.zrange(key, "-", "+", "BYLEX");
  return results.map(BigInt);
}

async function getLastSeenSeq(
  redis: Redis | Cluster,
  emitterChain: number,
  emitterAddress: string,
  watch: boolean = false,
): Promise<undefined | bigint> {
  let key = getKey(emitterChain, emitterAddress);
  if (watch) {
    await redis.watch(key);
  }
  const resp = await redis.zrange(key, "+", "-", "BYLEX", "REV", "LIMIT", 0, 1);
  if (resp.length === 0) {
    if (watch) {
      await redis.unwatch();
    }
    return null;
  }
  return BigInt(resp[0]);
}

export async function markProcessed(
  redis: Redis | Cluster,
  { emitterAddress, emitterChain, seq }: VaaKey,
  logger: Logger,
): Promise<void> {
  try {
    await redis.zadd(getKey(emitterChain, emitterAddress), 0, seq.toString());
  } catch (e) {
    logger?.error("could not mark sequence seen", e);
  }
}

function getKey(emitterChain: number, emitterAddress: string): string {
  return `missedVaas:${emitterChain}:${emitterAddress}`;
}

function getInProgressKey({
  emitterChain,
  emitterAddress,
  seq,
}: VaaKey): string {
  return `missedVaas:${emitterChain}:${emitterAddress}:${seq.toString()}`;
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

function vaaKeyReadable(key: VaaKey): {
  emitterAddress: string;
  emitterChain: string;
  sequence: string;
} {
  return {
    emitterAddress: key.emitterAddress,
    emitterChain: key.emitterChain.toString(),
    sequence: key.seq.toString(),
  };
}

async function fetchVaa(
  rpc: string[],
  { emitterChain, emitterAddress, seq }: VaaKey,
) {
  return await getSignedVAAWithRetry(
    rpc,
    emitterChain as ChainId,
    emitterAddress,
    seq.toString(),
    { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
    100,
    2,
  );
}
