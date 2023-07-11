import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import Redis, { Cluster } from "ioredis";
import { Registry, Counter, Histogram } from "prom-client";
import { ChainId, getSignedVAAWithRetry } from "@certusone/wormhole-sdk";
import { createPool, Pool } from "generic-pool";

import { defaultWormholeRpcs, ParsedVaaWithBytes, RelayerApp, RelayerEvents } from "../../application";
import { Logger } from "winston";
import { mapConcurrent, sleep } from "../../utils";
import { RedisConnectionOpts } from "../../storage/redis-storage";


export interface MissedVaaOpts extends RedisConnectionOpts {
  storagePrefix: string;
  registry?: Registry;
  logger?: Logger;
  wormholeRpcs?: string[];
  missedVaasConcurrency?: number;
  checkForMissedVaasEveryMs?: number;
  fetchConcurrency?: number;
  // The minimal sequence number the VAA worker will assume that should exist, by chain ID.
  startingSequenceConfig?: Record<Partial<ChainId>, bigint>;
}

export interface VaaKey {
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
}

interface FilterIdentifier {
  emitterChain: number;
  emitterAddress: string;
}

type ProcessVaaFn = (x: Buffer) => Promise<void>;

export function missedVaasV3(app: RelayerApp<any>, opts: MissedVaaOpts): void {
  opts.redis.keyPrefix = opts.namespace;
  opts.wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[app.env];

  const redisPool = createRedisPool(opts);

  // Start workers after filters have been loaded:
  setTimeout(async () => {
    const filters = app.filters.map(filter => {
      return {
        emitterChain: filter.emitterFilter.chainId,
        emitterAddress: filter.emitterFilter.emitterAddress,
      };
    });
    registerEventListeners(app, redisPool, opts);
    startMissedVaasWorkers(filters, redisPool, app.processVaa.bind(app), opts);
  }, 100);
}

async function registerEventListeners(
  app: RelayerApp<any>,
  redisPool: Pool<Redis | Cluster>,
  opts: MissedVaaOpts,
) {
  async function markVaaSeen(vaa: ParsedVaaWithBytes) {
    let redis: Redis | Cluster;
    try {
      redis = await redisPool.acquire();
    } catch (error) {
      opts.logger?.error(
        `Failed to acquire redis client while trying to mark vaa seen.`, error
      );
      return;
    }

    const { emitterChain, emitterAddress, sequence } = vaa;
    const seenVaaKey = getSeenVaaKey(opts.storagePrefix, emitterChain, emitterAddress.toString());

    try {
      await redis.zadd(seenVaaKey, 0, sequence.toString());
    } catch (error) {
      opts.logger?.error("Failed to mark VAA ass seen", error);
      return;
    }
  };

  app.addListener(RelayerEvents.Added, markVaaSeen);
  app.addListener(RelayerEvents.Skipped, markVaaSeen);
}

async function startMissedVaasWorkers(
  filters: FilterIdentifier[],
  redisPool: Pool<Cluster | Redis>,
  processVaa: ProcessVaaFn,
  opts: MissedVaaOpts,
) {
  const metrics: any = opts.registry ? initMetrics(opts.registry) : {};

  if (opts.storagePrefix) {
    /**
     * "storagePrefix" is the prefix used by the storage (currently redis-storage) to
     * store workflows. See RedisStorage.getPrefix
     * 
     * This is generating a dependency with the storage implementation, which is not ideal.
     * To solve this problem, we could add a new method to the storage interface to get seen sequences
     * and pass it to the missed vaas middleware
     * 
     * Untill that happens, we assume that if you pass in a storagePrefix property,
     * then you are using redis-storage
     */

    const startTime = Date.now();
    const scannedKeys = await updateSeenSequences(filters, redisPool, opts);
    const elapsedTime = Date.now() - startTime;
    opts.logger?.info(`Scanned ${scannedKeys} keys in ${elapsedTime}ms`);
    metrics.workersWarmupDuration?.observe(elapsedTime);
  }

  while (true) {
    opts.logger.info(`Missed VAA middleware run starting...`);
    await mapConcurrent(
      filters,
      async filter => {
        const { emitterChain, emitterAddress } = filter;
        let vaasFound = 0;

        opts.logger?.debug(
          `Checking for missed vaas for emitterChain/emitterAddress: ${emitterChain}/${emitterAddress}`
        );
        const startTime = Date.now();
        try {
          vaasFound = await checkForMissedVaas(filter, redisPool, processVaa, opts);

          metrics.workerSuccessfulRuns?.labels({ emitterChain, emitterAddress }).inc();
          if (vaasFound > 0) metrics.recoveredVaas?.labels({ emitterChain, emitterAddress }).inc(vaasFound);
        } catch (error) {
          metrics.workerFailedRuns?.labels({ emitterChain, emitterAddress }).inc();

          opts.logger?.error(
            `Error checking for missed vaas for filter: ${JSON.stringify(filter)}. Error: ${error.toString()}`,
          );
        } finally {
          const endTime = Date.now();
          metrics.workersRunDuration?.labels({ emitterChain, emitterAddress }).observe(endTime - startTime);
        }
        opts.logger?.debug(
          `Finished missed vaas check for emitterChain/emitterAddress: ${emitterChain}/${emitterAddress}. Found: ${vaasFound}`
        );
      },
      opts.missedVaasConcurrency || 1,
    );

    // TODO: if possible handle this in a more event driven way (intervals + locks on a per chain basis)
    sleep(opts.checkForMissedVaasEveryMs || 30_000);
  }
}

async function updateSeenSequences(
  filters: FilterIdentifier[],
  redisPool: Pool<Cluster | Redis>,
  opts: MissedVaaOpts,
) {
  let scannedKeys = 0;
  for (const filter of filters) {
    const { emitterChain, emitterAddress } = filter;
    opts.logger?.info(`Updating seen sequences for filter: ${emitterChain}/${emitterAddress}`);
    const redis = await redisPool.acquire();
    scannedKeys += await scanNextBatchAndUpdateSeenSequences(redis, filter, opts.storagePrefix);
  }
  return scannedKeys;
}

const CURSOR_IDENTIFIER = "0";
async function scanNextBatchAndUpdateSeenSequences(
  redis: Redis | Cluster,
  filter: FilterIdentifier,
  storagePrefix: string,
  cursor: string = CURSOR_IDENTIFIER,
  scannedKeys: number = 0,
): Promise<number> {
  const { emitterChain, emitterAddress } = filter;
  const prefix = `${storagePrefix}:${emitterChain}/${emitterAddress}`;
  const seenVaaKey = getSeenVaaKey(storagePrefix, emitterChain, emitterAddress);

  const [nextCursor, keysFound] = await redis.scan(cursor, "MATCH", `${prefix}*`);

  const pipeline = redis.pipeline();

  for (const key of keysFound) {
    scannedKeys++;
    if (key.endsWith(":logs")) continue;
    const vaaSequence = parseStorageVaaKey(key);
    pipeline.zadd(seenVaaKey, 0, vaaSequence);
  }

  await pipeline.exec();

  let nextBatchScannedKeys = 0;
  if (nextCursor !== CURSOR_IDENTIFIER) {
    nextBatchScannedKeys = await scanNextBatchAndUpdateSeenSequences(redis, filter, storagePrefix, nextCursor);
  }

  return scannedKeys + nextBatchScannedKeys;
}


async function checkForMissedVaas(
  filter: FilterIdentifier,
  redisPool: Pool<Cluster | Redis>,
  processVaa: ProcessVaaFn,
  opts: MissedVaaOpts,
): Promise<number> {
  const redis = await redisPool.acquire();
  const seenVaasKey = getSeenVaaKey(opts.storagePrefix, filter.emitterChain, filter.emitterAddress);

  const seenSequences = await getAllProcessedSeqsInOrder(redis, seenVaasKey);

  const missingVaasFound = [];

  if (seenSequences.length) {
    // Check if there is any leap between the sequences seen,
    // and try reprocessing them if any:
    const sequencesWithLeap = await scanForSequenceLeaps(redis, seenSequences);
    opts.logger?.debug("Found sequences with leap: ", JSON.stringify(sequencesWithLeap));
    missingVaasFound.push(...sequencesWithLeap);
    
    const pipeline = redis.pipeline();
    
    await mapConcurrent(sequencesWithLeap, async (sequence) => {
      const vaaKey = { ...filter, sequence };

      const success = await tryFetchAndProcess(vaaKey, processVaa, opts);

      if (success) {
        const seenVaaKey = getSeenVaaKey(opts.storagePrefix, filter.emitterChain, filter.emitterAddress);
        pipeline.zadd(seenVaaKey, 0, sequence.toString());
      }
    }, opts.fetchConcurrency);

    try {
      await pipeline.exec();
    } catch (error) {
      opts.logger?.warn("Some VAAs were processed but failed to be marked as seen");
      opts.logger?.error("Error marking VAAs as failed: ", error);
    }
  }

  // look ahead of greatest seen sequence in case the next vaa was missed
  // continue looking ahead until a vaa can't be fetched
  const lastSeenSequence = seenSequences[seenSequences.length - 1]
    || opts.startingSequenceConfig?.[filter.emitterChain as ChainId];

  if (lastSeenSequence) {
    for (let seq = lastSeenSequence + 1n; true; seq++) {
      const vaaKey = { ...filter, sequence: seq };
      const success = await tryFetchAndProcess(vaaKey, processVaa, opts);
      if (!success) break;
      missingVaasFound.push(seq);
    }
  }

  else {
    opts.logger?.warn(`No VAAs seen for filter: ${
      filter.emitterChain}/${filter.emitterAddress} and no starting sequence was configured. Won't check for missed VAAs.`);
  }
  return missingVaasFound.length;
}

async function scanForSequenceLeaps(
  redis: Redis | Cluster,
  seenSequences: bigint[],
) {
  const missing: bigint[] = [];
  let idx = 0;
  let nextSeen = seenSequences[0];

  for (let seq = seenSequences[0]; seq < seenSequences[seenSequences.length - 1]; seq++) {
    if (seq === nextSeen) {
      nextSeen = seenSequences[++idx];
      continue;
    }
    missing.push(seq);
  }

  return missing;
}

async function getAllProcessedSeqsInOrder(
  redis: Redis | Cluster,
  key: string,
): Promise<bigint[]> {
  const results = await redis.zrange(key, "-", "+", "BYLEX");
  return results.map(BigInt);
}

async function tryFetchAndProcess(vaaKey: VaaKey, processVaa: ProcessVaaFn, opts: MissedVaaOpts) {
  let vaa;
  try {
    vaa = await getSignedVAAWithRetry(
      opts.wormholeRpcs,
      vaaKey.emitterChain as ChainId,
      vaaKey.emitterAddress,
      vaaKey.sequence.toString(),
      { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
      100,
      2,
    );
  } catch (error) {
    if (error.code !== 5) {
      const vaaReadable = vaaKeyReadable(vaaKey);
      opts.logger?.error(`Failed to fetch vaa found missing. ${vaaReadable}`, error);
    }
    opts.logger?.error(`Vaa found missing not found on wormhole rpc: ${vaaKey.sequence.toString()}`);
    return false;
  }

  try {
    await processVaa(Buffer.from(vaa.vaaBytes));
  } catch (error) {
    const vaaReadable = vaaKeyReadable(vaaKey);
    opts.logger?.error(`Failed to process vaa found missing. ${vaaReadable}`, error);
    return false;
  }

  return true;
}

// example keys:
// {GenericRelayer}:GenericRelayer-relays:14/000000000000000000000000306b68267deb7c5dfcda3619e22e9ca39c374f84/55/O8xvv:logs
// {GenericRelayer}:GenericRelayer-relays:14/000000000000000000000000306b68267deb7c5dfcda3619e22e9ca39c374f84/49/d1Cjd
function parseStorageVaaKey(key: string) {
  const vaaIdString = key.split(":")[2];
  const sequenceString = vaaIdString.split("/")[2];
  return sequenceString;
}

function getSeenVaaKey(prefix: string, emitterChain: number, emitterAddress: string): string {
  return `${prefix}:missedVaasV3:seenVaas:${emitterChain}:${emitterAddress}`;
}

function initMetrics(registry: Registry) {
  const workerFailedRuns = new Counter({
    name: "missed_vaas_failed_runs",
    help: "The number of runs that missed vaa worker didn't finish running due to an error",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const workerSuccessfulRuns = new Counter({
    name: "missed_vaas_successful_runs",
    help: "The number of runs that missed vaa worker finished without errors",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const recoveredVaas = new Counter({
    name: "missed_vaas_recovered",
    help: "The number of VAAs recovered by the missed-vaas worker",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const workersRunDuration = new Histogram({
    name: "missed_vaas_worker_run_duration",
    help: "The duration of each of the worker runs",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
    buckets: [1000, 3000, 5000, 8000, 10000, 15000, 25000, 60000],
  });

  const workersWarmupDuration = new Histogram({
    name: "missed_vaas_worker_warmup_duration",
    help: "The duration of each of the worker warmup runs",
    registers: [registry],
    buckets: [50, 150, 1000, 5000, 10000, 20000, 40000],
  });

  return {
    workerFailedRuns,
    workerSuccessfulRuns,
    recoveredVaas,
    workersRunDuration,
    workersWarmupDuration,
  };
}

export function createRedisPool(opts: RedisConnectionOpts): Pool<Redis | Cluster> {
  const factory = {
    create: async function () {
      const redis = opts.redisCluster
        ? new Redis.Cluster(opts.redisClusterEndpoints, opts.redisCluster)
        : new Redis(opts.redis);
      // TODO: metrics.missed_vaa_redis_open_connections.inc();
      return redis;
    },
    destroy: async function (redis: Redis | Cluster) {
      // TODO: metrics.missed_vaa_redis_open_connections.dec();
    },
  };
  const poolOpts = {
    min: 5,
    max: 15,
    autostart: true,
  };
  return createPool(factory, poolOpts);
}

function vaaKeyReadable(key: VaaKey): string {
  return JSON.stringify({
    emitterAddress: key.emitterAddress,
    emitterChain: key.emitterChain.toString(),
    sequence: key.sequence.toString(),
  });
}
