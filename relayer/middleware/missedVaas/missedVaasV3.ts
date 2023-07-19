import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import Redis, { Cluster } from "ioredis";
import { Registry, Counter, Histogram, Gauge } from "prom-client";
import { ChainId, coalesceChainName, getSignedVAAWithRetry } from "@certusone/wormhole-sdk";
import { createPool, Pool } from "generic-pool";

import { defaultWormholeRpcs, ParsedVaaWithBytes, RelayerApp, RelayerEvents } from "../../application";
import { Logger } from "winston";
import { mapConcurrent, sleep } from "../../utils";
import { RedisConnectionOpts } from "../../storage/redis-storage";
import { GetSignedVAAResponse } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";


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
    const sequencesString = sequence.toString();
    try {
      await redis.zadd(seenVaaKey, sequencesString, sequencesString);
    } catch (error) {
      opts.logger?.error("Failed to mark VAA ass seen. Vaa will probably be reprocessed. Error: ", error);
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
        const filterLogger = opts.logger?.child({ emitterChain, emitterAddress });

        let vaasFound = 0;

        filterLogger?.debug(
          `Checking for missed vaas.`
        );
        const startTime = Date.now();
        const redis = await redisPool.acquire();
        let missedVaas: MissedVaaRunStats;
        try {
          missedVaas = await checkForMissedVaas(filter, redis, processVaa, opts, filterLogger);
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
        // This are VAAs that were found missing between known sequences, but we failed
        // to fetch them to reprocess them
        const vaasFailedToRecover = missedVaas.failedToRecover?.length || 0;
        // This are VAAs that were found but failed when trying to re-queue them
        const vaasFailedToReprocess = missedVaas.failedToReprocess?.length || 0;

        vaasFound += vaasProcessed + vaasFailedToReprocess;
        const labels = { emitterChain: coalesceChainName(emitterChain as ChainId), emitterAddress };
        if (vaasFound > 0) {
          filterLogger?.info(`Found missing VAAs (${vaasFound}). Sequences: ${JSON.stringify(missedVaas)}`)
          metrics.detectedVaas?.labels(labels).inc(vaasFound);
        }

        if (vaasProcessed > 0) {
          metrics.recoveredVaas?.labels(labels).inc(vaasProcessed);
        }

        if (vaasFailedToRecover > 0) {
          metrics.failedToRecover?.labels(labels).inc(vaasFailedToRecover);
        }

        if (vaasFailedToReprocess > 0) {
          metrics.failedToReprocess?.labels(labels).inc(vaasFailedToReprocess);
        }

        filterLogger?.debug(`Finished missed vaas check. Results: ${JSON.stringify(missedVaas)}}`);

        const { lastSeenSequence, firstSeenSequence, lastSafeSequence, foundMissingSequences } = missedVaas;

        metrics.lastSeenSequence?.labels(labels).set(lastSeenSequence);
        metrics.lastSafeSequence?.labels(labels).set(lastSafeSequence);
        metrics.firstSeenSequence?.labels(labels).set(firstSeenSequence);
        metrics.missingSequences?.labels(labels).set(foundMissingSequences ? 1 : 0);

        filterLogger?.info(
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
    pipeline.zadd(seenVaaKey, vaaSequence, vaaSequence);
  }

  await pipeline.exec();

  let nextBatchScannedKeys = 0;
  if (nextCursor !== CURSOR_IDENTIFIER) {
    nextBatchScannedKeys = await scanNextBatchAndUpdateSeenSequences(redis, filter, storagePrefix, seenVaaKey, nextCursor, scannedKeys);
  }

  return scannedKeys + nextBatchScannedKeys;
}

type MissedVaaRunStats = {
  processed: string[],
  failedToRecover: string[],
  failedToReprocess: string[],
  lastSeenSequence: number,
  firstSeenSequence: number,
  lastSafeSequence: number,
  foundMissingSequences: boolean,
};

async function checkForMissedVaas(
  filter: FilterIdentifier,
  redis: Cluster | Redis,
  processVaa: ProcessVaaFn,
  opts: MissedVaaOpts,
  logger?: Logger,
): Promise<MissedVaaRunStats> {
  const { storagePrefix } = opts;
  const { emitterChain, emitterAddress } = filter;

  const failedToFetchKey = getFailedToFetchKey(storagePrefix, emitterChain, emitterAddress);

  const failedToFetchSequences = await getDataFromSortedSet(redis, failedToFetchKey);

  if (failedToFetchSequences.length) {
    logger?.warn(
      `Found sequences that we failed to get from wormhole-rpc for chain ${emitterChain}: `
      + JSON.stringify(failedToFetchSequences)
    );
  }

  const lastSafeSequence = await getLastSafeSequence(redis, storagePrefix, emitterChain, emitterAddress, logger);

  const seenSequences = await getAllProcessedSeqsInOrder(
    redis,
    storagePrefix,
    emitterChain,
    emitterAddress,
    lastSafeSequence
  );

  const processed: string[] = [];
  const failedToRecover: string[] = [];
  const failedToReprocess: string[] = [];
  const firstSeenSequence = seenSequences[0] || 0;
  let foundMissingSequences = false;
  if (seenSequences.length) {
    const first = seenSequences[0];
    const last = seenSequences[seenSequences.length - 1];
    logger?.debug(`Checking for missing sequences between ${first} and ${last}`);
    // Check if there is any leap between the sequences seen,
    // and try reprocessing them if any:
    const missingSequences = await scanForSequenceLeaps(seenSequences);

    foundMissingSequences = missingSequences.length >= 1;
    if (foundMissingSequences) {
      logger?.warn(`Found sequences with leap: ` + JSON.stringify(
        missingSequences.map(s => s.toString()),
      ));
    }

    else {
      logger?.debug(`Found no sequences with leap.`);
    }

    const pipeline = redis.pipeline();
    let pipelineTouched = false;
    await mapConcurrent(missingSequences, async (sequence) => {
      const vaaKey = { ...filter, sequence };
      const seqString = sequence.toString();
      const seenVaaKey = getSeenVaaKey(storagePrefix, emitterChain, emitterAddress);

      let vaaResponse;
      try {
        vaaResponse = await tryFetchVaa(vaaKey, opts, opts.fetchVaaRetries);
        if (!vaaResponse) {
          // this is a sequence that we found in the middle of two other sequences we processed,
          // so we can consider this VAA not existing an error.
          throw new Error('VAA Sequence not found.');
        }
      } catch (error) {
        // We have already retried a few times. We'll swallow the error and mark
        // the VAA as failed and seen.
        // VAAs marked as failed generate a metric that can be used to trigger an alert
        // for developers to take a closer look.
        // At the time of the implementation of this worker, the guardian network in testnet has
        // only one guardian, and this makes it so that it's possible for some VAAs to be missed
        // by the guardian.
        // Right now the VAAs marked as failed are logged on each iteration of the missed VAA check
        // but it would be nice to have a way to query them
        logger?.error(`Error fetching VAA for missing sequence ${sequence}`, error);
        failedToRecover.push(seqString);
        pipeline.zadd(seenVaaKey, seqString, seqString);
        pipeline.zadd(failedToFetchKey, seqString, seqString);
        pipelineTouched = true;
        return;
      }

      try {
        await processVaa(Buffer.from(vaaResponse.vaaBytes));
        logger?.debug(`Recovered missing VAA ${seqString}`);
        pipelineTouched = true;
        pipeline.zadd(seenVaaKey, seqString, seqString);
        processed.push(seqString);
      } catch (error) {
        // If we succeeded to fetch the VAA The error to reprocess is in our side (eg: redis failed)
        // We won't mark it as failed, so that it's retried on the next run of the missed VAA Worker.
        // We won't throw the error so that other vaas can be processed, but we'll add it to the list
        // of "failedToReprocess" so that we can log it and alert on it.
        const vaaReadable = vaaKeyReadable(vaaKey);
        // If you see this log while troubleshooting, it probably means that there is an issue on the
        // relayer side since the VAA was successfully fetched but failed to be processed.
        logger?.error(`Failed to reprocess vaa found missing. ${vaaReadable}`, error);
        failedToReprocess.push(seqString);
      }
    }, opts.vaasFetchConcurrency);

    if (pipelineTouched) {
      try {
        await pipeline.exec();
      } catch (error) {
        logger?.warn("Some VAAs were processed but failed to be marked as seen");
        logger?.error("Error marking VAAs as failed: ", error);
      }
    }

    const missingSequencesSuccesfullyReprocessed = pipelineTouched 
      && failedToRecover.length === 0
      && failedToReprocess.length === 0;
    
    const lastSeenSequence = seenSequences[seenSequences.length - 1].toString();

    if (
      lastSeenSequence &&
      failedToFetchSequences.length === 0 &&
      (!missingSequences.length || missingSequencesSuccesfullyReprocessed)
    ) {
      // there are no missing sequences up to `lastSeenSequence`. We can assume it's safe to scan
      // from this point onwards next time
      // We need to add `lastSeenSequence to the condition because redis-storage current implementation
      // only keeps a certain amount of workflows in the queue, and so if we are getting many more messages
      // from a chain than from otherone, we might run into the case in which we have no seen sequences
      // even if we have processed some VAAs before for the chain.
      // This is possible in the case this is the first time the worker runs or if you used the `forceSeenKeysReindex`
      logger?.debug(`No missing sequences found up to sequence ${lastSeenSequence}. Setting as last sequence`)
      await setLastSafeSequence(
        redis,
        storagePrefix,
        emitterChain,
        emitterAddress,
        lastSeenSequence);
    }
  }

  // look ahead of greatest seen sequence in case the next vaa was missed
  // continue looking ahead until a vaa can't be fetched
  const lastSeq = seenSequences[seenSequences.length - 1];
  const startingSeq = opts.startingSequenceConfig?.[emitterChain as ChainId];
  let lastSeenSequence = lastSeq && startingSeq
    ? lastSeq > startingSeq ? lastSeq : startingSeq // same as Math.max, which doesn't support bigint
    : lastSeq || startingSeq;

  logger?.info(`Looking ahead for missed VAAs from sequence: ${
    lastSeenSequence
  }`);

  if (lastSeenSequence) {
    for (let seq = lastSeenSequence + 1n; true; seq++) {
      const vaaKey = { ...filter, sequence: seq };

      let vaa: GetSignedVAAResponse;
      try {
        vaa = await tryFetchVaa(vaaKey, opts, 3);
      } catch (error) {
        logger?.error(`Error FETCHING Look Ahead VAA. Sequence ${seq}. Error: `, error);
      }

      if (!vaa) break;

      logger?.info(`Found Look Ahead VAA. Sequence: ${seq.toString()}`);

      try {
        await processVaa(Buffer.from(vaa.vaaBytes));
        lastSeenSequence = seq;
        processed.push(seq.toString());
      } catch (error) {
        logger?.error(`Error PROCESSING Look Ahead VAA. Sequence: ${seq.toString()}. Error:`, error);
      }
    }
  }

  else {
    logger?.warn(`No VAAs seen and no starting sequence was configured. Won't check for missed VAAs.`);
  }

  return {
    processed,
    failedToRecover,
    failedToReprocess,
    foundMissingSequences,
    // Caveat: this values are used for metrics (prometheus gauges) and are expected to be numbers
    // this will become a problem once we get to sequences that are bigger than Number.MAX_SAFE_INTEGER
    // We've got some time though
    lastSeenSequence: Number(lastSeenSequence?.toString()),
    firstSeenSequence: Number(firstSeenSequence?.toString()),
    lastSafeSequence: Number(lastSafeSequence?.toString() || "0"),
  };
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

function getDataFromSortedSet(redis: Redis | Cluster, key: string, lowerBound?: number) {
  const lb = lowerBound || 0;

  return redis.zrange(key, lb, -1);
}

async function setLastSafeSequence(
  redis: Redis | Cluster,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  lastSeenSequence: string,
  logger?: Logger,
) {
  const key = getSafeSequenceKey(prefix, emitterChain, emitterAddress);
  // since safe sequence is not critical, we'll swallow the error
  try {
    await redis.set(key, lastSeenSequence.toString());
  } catch (error) {
    logger?.warn(`Error setting last safe sequence for chain: ${emitterChain}`, error);
    return false;
  }

  return true;
}

async function getLastSafeSequence(
  redis: Redis | Cluster,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  logger?: Logger,
): Promise<bigint> {
  // since safe sequence is not critical, we'll swallow the error
  const key = getSafeSequenceKey(prefix, emitterChain, emitterAddress);
  let lastSafeSequence: string;
  try {
    lastSafeSequence = await redis.get(key);
  } catch (error) {
    logger?.warn(`Error getting last safe sequence for chain: ${emitterChain}`, error);
    return null;
  }

  return lastSafeSequence ? BigInt(lastSafeSequence) : null;
}

async function getAllProcessedSeqsInOrder(
  redis: Redis | Cluster,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  lastSafeSequence?: bigint,
): Promise<bigint[]> {
  const key = getSeenVaaKey(prefix, emitterChain, emitterAddress);
  const sequenceToStartFrom = lastSafeSequence?.toString();
  let indexToStartFrom: number;
  if (sequenceToStartFrom) {
    indexToStartFrom = await redis.zrank(key, sequenceToStartFrom) || undefined;
  }

  const results = await getDataFromSortedSet(redis, key, indexToStartFrom);
  return results.map(r => Number(r)).sort((a, b) => a - b).map(BigInt);
}

async function tryFetchVaa(vaaKey: VaaKey, opts: MissedVaaOpts, retries: number = 2): Promise<GetSignedVAAResponse> {
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
    error.stack = new Error().stack;
    if (error.code === 5) {
      return null;
    }
    throw error;
  }
  return vaa as GetSignedVAAResponse;
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

function getFailedToFetchKey(prefix: string, emitterChain: number, emitterAddress: string): string {
  return `${prefix}:missedVaasV3:failedToFetch:${emitterChain}:${emitterAddress}`;
}

function getSafeSequenceKey(prefix: string, emitterChain: number, emitterAddress: string): string {
  return `${prefix}:missedVaasV3:safeSequence:${emitterChain}:${emitterAddress}`;
}

type MissedVaaMetrics = {
  workerFailedRuns: Counter;
  workerSuccessfulRuns: Counter;
  recoveredVaas: Counter;
  detectedVaas: Counter;
  failedToReprocess: Counter;
  failedToRecover: Counter;
  workerRunDuration: Histogram;
  workerWarmupDuration: Histogram;
  lastSeenSequence: Gauge;
  firstSeenSequence: Gauge;
  lastSafeSequence: Gauge;
  missingSequences: Gauge;
};

function initMetrics(registry: Registry): MissedVaaMetrics {
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

  const failedToRecover = new Counter({
    name: "missed_vaas_failed_to_recover",
    help: "The number of VAAs that were detected but failed to recover from the guardian api",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const lastSeenSequence = new Gauge({
    name: "missed_vaas_last_seen_sequence",
    help: "The last sequence seen by the missed-vaas worker",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const firstSeenSequence = new Gauge({
    name: "missed_vaas_first_seen_sequence",
    help: "The first sequence seen by the missed-vaas worker",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const lastSafeSequence = new Gauge({
    name: "missed_vaas_last_safe_sequence",
    help: "The max sequence we know that has all VAAs with previous sequences processed",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const missingSequences = new Gauge({
    name: "missed_vaas_missing_sequences",
    help: "The number of sequences missing from the missed-vaas worker",
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
    failedToRecover,
    failedToReprocess,
    workerRunDuration,
    workerWarmupDuration,
    firstSeenSequence,
    lastSeenSequence,
    lastSafeSequence,
    missingSequences,
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
