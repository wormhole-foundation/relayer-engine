import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";

import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import Redis, {
  Cluster,
  ClusterNode,
  ClusterOptions,
  RedisOptions,
} from "ioredis";
import { ChainId, getSignedVAAWithRetry } from "@certusone/wormhole-sdk";
import { defaultWormholeRpcs, RelayerApp, RelayerEvents } from "../application";
import { Logger } from "winston";
import { createPool, Pool } from "generic-pool";
import { sleep } from "../utils";

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

export function missedVaas(
  app: RelayerApp<any>,
  opts: MissedVaaOpts,
): Middleware {
  opts.redis = opts.redis || { host: "localhost", port: 6379 };
  opts.redis.keyPrefix = opts.namespace;
  opts.checkForMissedVaasEveryMs = opts.checkForMissedVaasEveryMs || 30_000;

  const factory = {
    create: async function () {
      const redis = opts.redisCluster
        ? new Redis.Cluster(opts.redisClusterEndpoints, opts.redisCluster)
        : new Redis(opts.redis);
      return redis;
    },
    destroy: async function () {
      // do something when destroyed?
    },
  };
  const poolOpts = {
    min: 5,
    max: 15,
    autostart: true,
  };

  const redisPool = createPool(factory, poolOpts);

  setTimeout(() => startMissedVaaWorker(redisPool, app, opts), 100); // start worker once config is done.

  app.on(RelayerEvents.Skipped, async vaa => {
    // when we skip vaas, we still want to mark them as seen, since the middleware doesn't know that we actually saw them and skipped them
    // it will think we missed it if we don't do this
    const redis = await redisPool.acquire();
    try {
      await setLastSequenceForContract(
        redis,
        vaa.emitterChain,
        vaa.emitterAddress,
        vaa.sequence,
        opts.logger,
      );
    } finally {
      await redisPool.release(redis);
    }
  });

  return async (ctx: Context, next) => {
    const wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[ctx.env];

    let vaa = ctx.vaa;
    if (!vaa) {
      await next();
      return;
    }

    const redis = await redisPool.acquire();

    const lastSeenSequence = await getLastSequenceForContract(
      redis,
      vaa.emitterChain,
      vaa.emitterAddress,
    );

    if (lastSeenSequence && lastSeenSequence.lastSequence + 1n < vaa.sequence) {
      // possibly missed some vaas
      for (
        let currentSeq = lastSeenSequence.lastSequence;
        currentSeq < vaa.sequence;
        currentSeq++
      ) {
        try {
          const fetchedVaa = await fetchVaa(
            // we could use app.fetchVaa. Considering it.. for now each middleware is mostly self contained
            wormholeRpcs,
            vaa.emitterChain as ChainId,
            vaa.emitterAddress,
            currentSeq,
          );
          let addr = vaa.emitterAddress.toString("hex");
          let seq = currentSeq.toString();
          ctx.logger?.info(
            `Possibly missed a vaa: ${vaa.emitterChain}/${addr}/${seq}. Adding to queue.`,
          );
          await ctx.processVaa(Buffer.from(fetchedVaa.vaaBytes)); // push the missed vaa through all the middleware / storage service if used.
        } catch (e) {
          ctx.logger?.error(
            `Could not process missed vaa. Sequence: ${currentSeq}`,
            e,
          );
        }
      }
    } else {
      ctx.logger?.debug(
        "No missed VAAs detected between this VAA and the last VAA we processed.",
      );
    }
    try {
      await setLastSequenceForContract(
        redis,
        vaa.emitterChain,
        vaa.emitterAddress,
        vaa.sequence,
        ctx.logger,
      );
    } finally {
      await redisPool.release(redis);
    }

    await next(); // <-- process the current vaa
  };
}

function getKey(emitterChain: number, emitterAddress: Buffer): string {
  let emitterAddressStr = emitterAddress.toString("hex");
  return `missedVaas:${emitterChain}:${emitterAddressStr}`;
}

async function getLastSequenceForContract(
  redis: Redis | Cluster,
  emitterChain: number,
  emitterAddress: Buffer,
  watch: boolean = false,
): Promise<{ lastSequence: bigint; timestamp: Date } | null> {
  let key = getKey(emitterChain, emitterAddress);
  if (watch) {
    await redis.watch(key);
  }
  let lastSeqRaw = await redis.get(key);
  if (!lastSeqRaw) {
    await redis.unwatch();
    return null;
  }
  let { lastSequence, timestamp } = JSON.parse(lastSeqRaw);
  return { lastSequence: BigInt(lastSequence), timestamp: new Date(timestamp) };
}

// TODO concurrency issue. This should be done in a lua script or use watch to avoid racing between step 1 and step 3
async function setLastSequenceForContract(
  redis: Redis | Cluster,
  emitterChain: number,
  emitterAddress: Buffer,
  seq: bigint,
  logger?: Logger,
): Promise<boolean> {
  // step 1. fetch current last sequence
  let lastSeq = await getLastSequenceForContract(
    redis,
    emitterChain,
    emitterAddress,
    true,
  );
  // step 2. if we have already seen an older seq, skip
  if (lastSeq && BigInt(lastSeq.lastSequence) > seq) {
    logger?.debug(
      `Did not update last sequence due to an older one being processed. Last seen ${lastSeq.lastSequence.toString()}, Current: ${seq.toString()}.`,
    );
    await redis.unwatch();
    return false;
  }

  // step 3. if we haven't seen an older seq, set this one as the last seen.
  try {
    await redis
      .multi()
      .set(
        getKey(emitterChain, emitterAddress),
        JSON.stringify({ lastSequence: seq.toString(), timestamp: Date.now() }),
      )
      .exec();
  } catch (e) {
    logger?.error("could not update lastSequence", e);
  }
  return true;
}

async function fetchVaa(
  rpc: string[],
  chain: ChainId,
  emitterAddress: Buffer,
  sequence: bigint,
) {
  return await getSignedVAAWithRetry(
    rpc,
    chain,
    emitterAddress.toString("hex"),
    sequence.toString(),
    { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
    100,
    2,
  );
}

async function startMissedVaaWorker(
  pool: Pool<Cluster | Redis>,
  app: RelayerApp<any>,
  opts: MissedVaaOpts,
) {
  const wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[app.env];
  const logger = opts.logger;

  while (true) {
    try {
      let redis = await pool.acquire();
      try {
        logger.debug(`Checking for missed VAAs.`);
        let addressWithLastSequence = await Promise.all(
          app.filters
            .map(filter => ({
              emitterChain: filter.emitterFilter.chainId,
              emitterAddress: Buffer.from(
                filter.emitterFilter.emitterAddress,
                "hex",
              ),
            }))
            .map(async address => {
              const lastSequence = await getLastSequenceForContract(
                redis,
                address.emitterChain,
                address.emitterAddress,
              );
              return { address, lastSequence };
            }),
        );

        for (const { address, lastSequence } of addressWithLastSequence) {
          if (!lastSequence) {
            continue;
          }
          try {
            let nextSequence = lastSequence.lastSequence + 1n;
            while (true) {
              // iterate until fetchVaa throws because we couldn't find a next vaa.
              let vaa = await fetchVaa(
                wormholeRpcs,
                address.emitterChain as ChainId,
                address.emitterAddress,
                nextSequence,
              );
              logger?.info(`Found missed VAA via the missedVaaWorker.`, {
                emitterChain: address.emitterChain,
                emitterAddress: address.emitterAddress.toString("hex"),
                sequence: nextSequence.toString(),
              });
              app.processVaa(Buffer.from(vaa.vaaBytes));
              nextSequence++;
            }
          } catch (e) {
            if (e.code !== 5) {
              // 5: requested VAA not found in store
              throw e;
            }
          }
        }
      } catch (e) {
        logger?.error(`startMissedVaaWorker loop failed with error`, e);
      }
      await pool.release(redis);
    } catch (e) {
      logger?.error(`error managing redis pool.`, e);
    }
    await sleep(opts.checkForMissedVaasEveryMs);
  }
}
