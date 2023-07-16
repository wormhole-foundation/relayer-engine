import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import Redis, { Cluster } from "ioredis";
import { Registry, Counter, Histogram } from "prom-client";
import { ChainId, coalesceChainName, getSignedVAAWithRetry } from "@certusone/wormhole-sdk";
import { createPool, Pool } from "generic-pool";

import { defaultWormholeRpcs, ParsedVaaWithBytes, RelayerApp, RelayerEvents } from "../../application";
import { Logger } from "winston";
import { mapConcurrent, sleep } from "../../utils";
import { RedisConnectionOpts } from "../../storage/redis-storage";


export interface MissedVaaOpts extends RedisConnectionOpts {
  registry?: Registry;
  logger?: Logger;
  wormholeRpcs?: string[];
  // How many "source" chains will be scanned for missed VAAs concurrently.
  concurrency?: number;
  // Interval at which the worker will check for missed VAAs.
  checkInterval?: number;
  // Times a VAA will be tried to be fetched when it's found missing
  fetchVaaRetries?: number;
  // Max concurrency used for fetching VAAs from wormscan.
  vaasFetchConcurrency?: number;
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
  storagePrefix: string;
  // The minimal sequence number the VAA worker will assume that should exist, by chain ID.
  startingSequenceConfig?: Partial<Record<ChainId, bigint>>;
  // If true the key will remove the existing sorted set containing seen keys and reindex all keys
  // getting the from storage. This probably can be used in combination with startingSequenceConfig
  // to force reprocessing of certain VAAs.
  // WARN: skipped VAAs will be reprocessed.
  forceSeenKeysReindex?: boolean;
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

/**
 * 
 * @param app 
 * @param opts 
 */
export function spawnMissedVaaWorker(app: RelayerApp<any>, opts: MissedVaaOpts): void {
  opts.wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[app.env];
  const metrics: any = opts.registry ? initMetrics(opts.registry) : {};
  const redisPool = createRedisPool(opts);

  if (!app.filters.length) {
    opts.logger?.warn("Missed VAA Worker: No filters found, retrying in 100ms...");
    setTimeout(() => {
      spawnMissedVaaWorker(app, opts);
    }, 100);
    return;
  }

  const filters = app.filters.map(filter => {
    return {
      emitterChain: filter.emitterFilter.chainId,
      emitterAddress: filter.emitterFilter.emitterAddress,
    };
  });
  registerEventListeners(app, redisPool, opts);
  startMissedVaasWorkers(filters, redisPool, app.processVaa.bind(app), opts, metrics);
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
      await redisPool.release(redis);
      return;
    }

    const { emitterChain, emitterAddress, sequence } = vaa;
    const seenVaaKey = getSeenVaaKey(opts.storagePrefix, emitterChain, emitterAddress.toString('hex'));

    try {
      await redis.zadd(seenVaaKey, 0, sequence.toString());
    } catch (error) {
      opts.logger?.error("Failed to mark VAA ass seen", error);
    } finally {
      await redisPool.release(redis);
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
  metrics: MissedVaaMetrics,
) {
  // The prefix used by the storage to store workflows.
  // We'll use it to go into the queue, and build a map of what
  // sequences have already been processed according to the store
  if (opts.storagePrefix) {
    const startTime = Date.now();
    const scannedKeys = await updateSeenSequences(filters, redisPool, opts);
    const elapsedTime = Date.now() - startTime;
    opts.logger?.info(`Scanned ${scannedKeys} keys in ${elapsedTime}ms`);
    metrics.workerWarmupDuration?.observe(elapsedTime);
  }

  while (true) {
    opts.logger.info(`Missed VAA middleware run starting...`);
    await mapConcurrent(
      filters,
      async filter => {
        const { emitterChain, emitterAddress } = filter;
        let vaasFound = 0;

        opts.logger?.debug(
          `Checking for missed vaas for Chain: ${emitterChain}`
        );
        const startTime = Date.now();
        const redis = await redisPool.acquire();
        let missedVaas: { failed: string[], processed: string[] };
        try {
          missedVaas = await checkForMissedVaas(filter, redis, processVaa, opts);
        
        } catch (error) {
          metrics.workerFailedRuns?.labels().inc();
          opts.logger?.error(
            `Error checking for missed vaas for filter: ${JSON.stringify(filter)}}`, error
          );
        }     

        redisPool.release(redis);

        metrics.workerSuccessfulRuns?.labels().inc();
        metrics.workerRunDuration?.labels().observe(Date.now() - startTime);
        
        const vaasProcessed = missedVaas.processed?.length || 0;
        // This are VAAs that were found but failed when trying to re-queue them.
        // For example, the VAA wasn't found on wormscan
        const vaasFailedToReprocess = missedVaas.failed?.length || 0;

        vaasFound += vaasProcessed + vaasFailedToReprocess;
        const labels = { emitterChain: coalesceChainName(emitterChain as ChainId), emitterAddress };
        if (vaasFound > 0) metrics.detectedVaas?.labels(labels).inc(vaasFound);
        if (vaasProcessed > 0) {
          metrics.recoveredVaas?.labels(labels).inc(vaasProcessed);
          opts.logger?.debug(`For chain ${labels.emitterChain}} Found missed Vaas with seq: ${missedVaas.processed.join(', ')}`)
        }
        if (vaasFailedToReprocess > 0) {
          metrics.failedToReprocess?.labels(labels).inc(vaasFailedToReprocess);
          opts.logger?.debug(`For chain ${labels.emitterChain}} Failed to reprocess missed Vaas with seq: ${missedVaas.failed.join(', ')}`);
        }

        opts.logger?.info(
          `Finished missed vaas check for emitterChain: ${emitterChain}. Found: ${vaasFound}`
        );
      },
      opts.concurrency || 1,
    );

    // TODO: if possible handle this in a more event driven way (intervals + locks on a per chain basis)
    await sleep(opts.checkInterval || 30_000);
  }
}

async function updateSeenSequences(
  filters: FilterIdentifier[],
  redisPool: Pool<Cluster | Redis>,
  opts: MissedVaaOpts,
) {
  const redis = await redisPool.acquire();
  let scannedKeys = 0;
  try {
    for (const filter of filters) {
      const seenVaaKey = getSeenVaaKey(
        opts.storagePrefix,
        filter.emitterChain,
        filter.emitterAddress
      );

      if (opts.forceSeenKeysReindex) {
        opts.logger?.info(`Deleting ${seenVaaKey} key to force reindexing of seen keys`);
        await redis.del(seenVaaKey);
      }

      scannedKeys += await scanNextBatchAndUpdateSeenSequences(redis, filter, opts.storagePrefix, seenVaaKey);
    }
  } finally {
    redisPool.release(redis);
  }

  return scannedKeys;
}

const CURSOR_IDENTIFIER = "0";
async function scanNextBatchAndUpdateSeenSequences(
  redis: Redis | Cluster,
  filter: FilterIdentifier,
  storagePrefix: string,
  seenVaaKey: string,
  cursor: string = CURSOR_IDENTIFIER,
  scannedKeys: number = 0,
): Promise<number> {
  const { emitterChain, emitterAddress } = filter;
  const prefix = `${storagePrefix}:${emitterChain}/${emitterAddress}`;
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
    nextBatchScannedKeys = await scanNextBatchAndUpdateSeenSequences(redis, filter, storagePrefix, seenVaaKey, nextCursor, scannedKeys);
  }

  return scannedKeys + nextBatchScannedKeys;
}

async function checkForMissedVaas(
  filter: FilterIdentifier,
  redis: Cluster | Redis,
  processVaa: ProcessVaaFn,
  opts: MissedVaaOpts,
): Promise<{ failed: string[], processed: string[] }> {
  const seenVaasKey = getSeenVaaKey(opts.storagePrefix, filter.emitterChain, filter.emitterAddress);
  const failedToProcessKey = getFailedToProcessKey(opts.storagePrefix, filter.emitterChain, filter.emitterAddress);

  const failedToProcessSequences = await getDataFromSortedSet(redis, failedToProcessKey);

  if (failedToProcessSequences.length) {
    opts.logger?.warn(`Found sequences that failed to process for chain ${
      filter.emitterChain}: ` + JSON.stringify(failedToProcessSequences));
  }

  const seenSequences = await getAllProcessedSeqsInOrder(redis, seenVaasKey);
  const failed: string[] = [];
  const processed: string[] = [];

  if (seenSequences.length) {
    // Check if there is any leap between the sequences seen,
    // and try reprocessing them if any:
    const sequencesWithLeap = await scanForSequenceLeaps(seenSequences);

    opts.logger?.warn(`Found sequences with leap for chain ${filter.emitterChain}: ` + JSON.stringify(
      sequencesWithLeap.map(s => s.toString()),
    ));

    const pipeline = redis.pipeline();
    let pipelineTouched = sequencesWithLeap.length >= 1;

    await mapConcurrent(sequencesWithLeap, async (sequence) => {
      const vaaKey = { ...filter, sequence };
      const seqString = sequence.toString();
      const seenVaaKey = getSeenVaaKey(opts.storagePrefix, filter.emitterChain, filter.emitterAddress);
      const success = await tryFetchAndProcess(vaaKey, processVaa, opts, opts.fetchVaaRetries);

      if (!success) {
        opts.logger?.warn(`Failed to reprocess sequence ${sequence} for chain: ${filter.emitterChain}`);
        pipeline.zadd(failedToProcessKey, 0, seqString);
        failed.push(seqString);
      }

      else {
        processed.push(seqString);
      }

      pipeline.zadd(seenVaaKey, 0, seqString);
    }, opts.vaasFetchConcurrency);

    if (pipelineTouched) {
      try {
        await pipeline.exec();
      } catch (error) {
        opts.logger?.warn("Some VAAs were processed but failed to be marked as seen");
        opts.logger?.error("Error marking VAAs as failed: ", error);
      }
    }
  }

  // look ahead of greatest seen sequence in case the next vaa was missed
  // continue looking ahead until a vaa can't be fetched
  const lastSeq = seenSequences[seenSequences.length - 1];
  const startingSeq = opts.startingSequenceConfig?.[filter.emitterChain as ChainId];
  const lastSeenSequence = lastSeq && startingSeq
    ? lastSeq > startingSeq ? lastSeq : startingSeq
    : lastSeq || startingSeq;

  opts.logger?.info(`Looking ahead for missed VAAs for chain: ${filter.emitterChain}. From Sequence: ${
    lastSeenSequence
  } A "not found" should be logged soon.`);

  if (lastSeenSequence) {
    for (let seq = lastSeenSequence + 1n; true; seq++) {
      const vaaKey = { ...filter, sequence: seq };
      // when scanning ahead we only retry once, since we are expecting not to find any VAA.
      // if we fail by another error it will be picked up by the next run of the 
      // missed-vaa worker (either by the leap-scan or by the look-ahead)
      const success = await tryFetchAndProcess(vaaKey, processVaa, opts, 1);
      if (!success) break;
      processed.push(seq.toString());
    }
  }

  else {
    opts.logger?.warn(`No VAAs seen for chain: ${filter.emitterChain} and no starting sequence was configured. Won't check for missed VAAs.`);
  }

  return { processed, failed };
}

async function scanForSequenceLeaps(
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

function getDataFromSortedSet(redis: Redis | Cluster, key: string) {
  return redis.zrange(key, "-", "+", "BYLEX");
}

async function getAllProcessedSeqsInOrder(
  redis: Redis | Cluster,
  key: string,
): Promise<bigint[]> {
  const results = await getDataFromSortedSet(redis, key);
  return results.map(r => Number(r)).sort((a, b) => a - b).map(BigInt);
}

async function tryFetchAndProcess(vaaKey: VaaKey, processVaa: ProcessVaaFn, opts: MissedVaaOpts, retries: number = 2) {
  let vaa;
  const stack = new Error().stack;
  try {
    vaa = await getSignedVAAWithRetry(
      opts.wormholeRpcs,
      vaaKey.emitterChain as ChainId,
      vaaKey.emitterAddress,
      vaaKey.sequence.toString(),
      { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
      100,
      retries,
    );
  } catch (error) {
    const vaaReadable = vaaKeyReadable(vaaKey);
    error.stack = new Error().stack;
    if (error.code === 5) {
      opts.logger?.error(`Vaa ${vaaReadable} not found on wormhole rpc while fetching missed vaa`);
      return false;
    }
    opts.logger?.error(`Failed to fetch missing vaa from wormhole rpc. ${vaaReadable}`, error);
    throw error;
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

function getFailedToProcessKey(prefix: string, emitterChain: number, emitterAddress: string): string {
  return `${prefix}:missedVaasV3:failedToProcess:${emitterChain}:${emitterAddress}`;
}

type MissedVaaMetrics = {
  workerFailedRuns: Counter;
  workerSuccessfulRuns: Counter;
  recoveredVaas: Counter;
  detectedVaas: Counter;
  failedToReprocess: Counter;
  workerRunDuration: Histogram;
  workerWarmupDuration: Histogram;
};

function initMetrics(registry: Registry) {
  const workerFailedRuns = new Counter({
    name: "missed_vaas_failed_runs",
    help: "The number of runs that missed vaa worker didn't finish running due to an error",
    registers: [registry],
  });

  const workerSuccessfulRuns = new Counter({
    name: "missed_vaas_successful_runs",
    help: "The number of runs that missed vaa worker finished without errors",
    registers: [registry],
  });

  const recoveredVaas = new Counter({
    name: "missed_vaas_recovered",
    help: "The number of VAAs recovered by the missed-vaas worker",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const detectedVaas = new Counter({
    name: "missed_vaas_detected",
    help: "The number of VAAs detected by the missed-vaas worker",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const failedToReprocess = new Counter({
    name: "missed_vaas_failed_to_reprocess",
    help: "The number of VAAs that were detected but failed to reprocess",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const workerRunDuration = new Histogram({
    name: "missed_vaas_worker_run_duration",
    help: "The duration of each of the worker runs",
    registers: [registry],
    buckets: [500, 1000, 60000, 120000],
  });

  const workerWarmupDuration = new Histogram({
    name: "missed_vaas_worker_warmup_duration",
    help: "The duration of each of the worker warmup runs",
    registers: [registry],
    buckets: [500, 1000, 60000, 120000],
  });

  return {
    workerFailedRuns,
    workerSuccessfulRuns,
    detectedVaas,
    recoveredVaas,
    failedToReprocess,
    workerRunDuration,
    workerWarmupDuration,
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
  return `${coalesceChainName(key.emitterChain as ChainId)}(${key.emitterChain})/${key.sequence}`;
}
