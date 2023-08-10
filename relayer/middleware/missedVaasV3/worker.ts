import Redis, { Cluster } from "ioredis";
import { Registry } from "prom-client";
import { ChainId } from "@certusone/wormhole-sdk";
import { Pool } from "generic-pool";
import { Logger } from "winston";

import { defaultWormholeRpcs, ParsedVaaWithBytes, RelayerApp, RelayerEvents } from "../../application";
import { mapConcurrent, sleep } from "../../utils";
import { RedisConnectionOpts } from "../../storage/redis-storage";
import { initMetrics, MissedVaaMetrics } from "./metrics";
import { MissedVaaRunStats, calculateSequenceStats, updateMetrics } from "./helpers";
import { ProcessVaaFn, checkForMissedVaas } from "./check";
import {
  createRedisPool,
  markVaaAsSeen,
  deleteExistingSeenVAAsData,
  updateSeenSequences,
  trySetLastSafeSequence,
  tryGetLastSafeSequence,
  tryGetExistingFailedSequences
} from './storage';

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
  storagePrefix?: string;
  // The minimal sequence number the VAA worker will assume that should exist, by chain ID.
  startingSequenceConfig?: Partial<Record<ChainId, bigint>>;
  // If true the key will remove the existing sorted set containing seen keys and reindex all keys
  // getting the from storage. This probably can be used in combination with startingSequenceConfig
  // to force reprocessing of certain VAAs.
  // WARN: skipped VAAs will be reprocessed.
  forceSeenKeysReindex?: boolean;
}

export interface FilterIdentifier {
  emitterChain: number;
  emitterAddress: string;
}

let metrics: MissedVaaMetrics;

export function spawnMissedVaaWorker(app: RelayerApp<any>, opts: MissedVaaOpts): void {
  opts.wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[app.env];
  if (!metrics) {
    metrics = opts.registry ? initMetrics(opts.registry) : {};
  }

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
  startMissedVaasWorkers(filters, redisPool, app.processVaa.bind(app), opts);
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

    try {
      await markVaaAsSeen(redis, vaa.id, opts);
    } catch (error) {
      opts.logger?.error(`Failed to mark VAA ass seen ${vaa.id.sequence}. Vaa will probably be reprocessed. Error: `, error);
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
) {
  await redisPool.use(async (redis) => {
    if (opts.storagePrefix && opts.forceSeenKeysReindex) {
      await deleteExistingSeenVAAsData(
        filters, redis, opts.storagePrefix, opts.logger
      );
    }

    // The prefix used by the storage to store workflows.
    // We'll use it to go into the queue, and build a map of what
    // sequences have already been processed according to the store
    if (opts.storagePrefix) {
      const startTime = Date.now();
      const redis = await redisPool.acquire();
      const scannedKeys = await updateSeenSequences(filters, redis, opts.storagePrefix);
      const elapsedTime = Date.now() - startTime;
      metrics.workerWarmupDuration?.observe(elapsedTime);
      opts.logger?.info(`Scanned ${scannedKeys} keys in ${elapsedTime}ms`);
    }
  });

  while (true) {
    opts.logger.info(`Missed VAA middleware run starting...`);
    await mapConcurrent(
      filters,
      filter => redisPool.use(async redis => {
        const { storagePrefix } = opts;
        const { emitterChain, emitterAddress } = filter;
        const filterLogger = opts.logger?.child({ emitterChain, emitterAddress });

        const startTime = Date.now();

        const previousSafeSequence = await tryGetLastSafeSequence(
          redis, storagePrefix, emitterChain, emitterAddress, filterLogger
        );

        let missedVaas: MissedVaaRunStats;

        try {
          missedVaas = await checkForMissedVaas(filter, redis, processVaa, opts, previousSafeSequence, filterLogger);

          metrics.workerSuccessfulRuns?.labels().inc();
          metrics.workerRunDuration?.labels().observe(Date.now() - startTime);
        } catch (error) {
          opts.logger?.error(
            `Error checking for missed vaas for filter: ${JSON.stringify(filter)}}`, error
          );

          metrics.workerFailedRuns?.labels().inc();
          metrics.workerRunDuration?.labels().observe(Date.now() - startTime);
        }

        // TODO: this is an ugly way to handle the error
        const failedToFetchSequencesOrError = await tryGetExistingFailedSequences(redis, filter, opts.storagePrefix);
        if (!Array.isArray(failedToFetchSequencesOrError)) {
          filterLogger?.error(
            `Failed to get existing failed sequences from redis. Error: `, failedToFetchSequencesOrError
          );
        } else if (failedToFetchSequencesOrError.length) {
          filterLogger?.warn(
            `Found sequences that we failed to get from wormhole-rpc. Sequences: `
            + JSON.stringify(failedToFetchSequencesOrError)
          );
        } else {
          filterLogger?.debug("No previous failed sequences found.");
        }

        const failedToFetchSequences = Array.isArray(failedToFetchSequencesOrError)
          ? failedToFetchSequencesOrError
          : null;

        const sequenceStats = calculateSequenceStats(
          missedVaas,
          failedToFetchSequences,
          previousSafeSequence?.toString()
        );

        const { lastSafeSequence, lastSeenSequence, firstSeenSequence } = sequenceStats;

        if (lastSafeSequence > 0 && failedToFetchSequences !== null) {
          filterLogger?.debug(
            `No missing sequences found up to sequence ${lastSafeSequence}. Setting as last sequence`
          );
          await trySetLastSafeSequence(
            redis,
            storagePrefix,
            emitterChain,
            emitterAddress,
            lastSafeSequence);
        }

        updateMetrics(metrics, filter, missedVaas, sequenceStats);

        const vaasFound = missedVaas.missingSequences.length
          + missedVaas.lookAheadSequences.length;

        filterLogger?.info(
          `Finished missed VAAs check. Found: ${vaasFound}. Enable debug to see a log with precise results.`
        );

        filterLogger?.debug(`Finished missed vaas check. Results: ${JSON.stringify({
          missedVaas, lastSafeSequence, lastSeenSequence, firstSeenSequence
        })}}`);
      }),
      opts.concurrency || 1,
    );

    // TODO: if possible handle this in a more event driven way (intervals + locks on a per chain basis)
    await sleep(opts.checkInterval || 30_000);
  }
}


