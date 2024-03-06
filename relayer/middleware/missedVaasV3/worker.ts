import { Cluster, Redis } from "ioredis";
import { Registry } from "prom-client";
import { createPool, Pool } from "generic-pool";
import { Logger } from "winston";

import {
  defaultWormholeRpcs,
  defaultWormscanUrl,
  RelayerApp,
} from "../../application.js";
import { mapConcurrent, sleep } from "../../utils.js";
import { RedisConnectionOpts } from "../../storage/redis-storage.js";
import { initMetrics, MissedVaaMetrics } from "./metrics.js";
import {
  calculateSequenceStats,
  MissedVaaRunStats,
  updateMetrics,
} from "./helpers.js";
import {
  checkForMissedVaas,
  ProcessVaaFn,
  refreshSeenSequences,
  registerEventListeners,
} from "./check.js";

import {
  tryGetExistingFailedSequences,
  tryGetLastSafeSequence,
  trySetLastSafeSequence,
} from "./storage.js";
import {
  Wormholescan,
  WormholescanClient,
} from "../../rpc/wormholescan-client.js";
import { ChainId } from "@wormhole-foundation/sdk";

const DEFAULT_PREFIX = "MissedVaaWorkerV3";

export interface MissedVaaOpts extends RedisConnectionOpts {
  registry?: Registry;
  logger?: Logger;
  wormholeRpcs: string[];
  wormscanUrl?: string;
  // How many "source" chains will be scanned for missed VAAs concurrently.
  concurrency?: number;
  // Interval at which the worker will check for missed VAAs.
  checkInterval?: number;
  // Times a VAA will be tried to be fetched when it's found missing
  fetchVaaRetries?: number;
  maxLookAhead?: number;
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

export async function spawnMissedVaaWorker(
  app: RelayerApp<any>,
  opts: MissedVaaOpts,
): Promise<void> {
  opts.wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[app.env];
  opts.wormscanUrl = opts.wormscanUrl ?? defaultWormscanUrl[app.env];
  if (!metrics) {
    metrics = opts.registry ? initMetrics(opts.registry) : {};
  }

  if (!opts.maxLookAhead && opts.maxLookAhead !== 0) {
    opts.maxLookAhead = 10;
  }

  const redisPool = createRedisPool(opts);
  const wormholescan = new WormholescanClient(new URL(opts.wormscanUrl), {
    maxDelay: 60_000,
    noCache: true,
  });

  if (!app.filters.length) {
    opts.logger?.warn(
      "Missed VAA Worker: No filters found, retrying in 100ms...",
    );
    setTimeout(() => {
      spawnMissedVaaWorker(app, opts);
    }, 100);
    return;
  }

  const filters = app.filters.map(filter => {
    return {
      emitterChain: filter.emitterFilter!.chainId,
      emitterAddress: filter.emitterFilter!.emitterAddress,
    };
  });

  const prefix = opts.storagePrefix || DEFAULT_PREFIX;

  if (opts.storagePrefix) {
    await refreshSeenSequences(redisPool, filters as FilterIdentifier[], opts);
  }

  registerEventListeners(app, redisPool, opts, prefix);

  while (true) {
    opts.logger?.info(`Missed VAA middleware run starting...`);
    await mapConcurrent(filters, filter =>
      redisPool.use(async redis => {
        const startTime = Date.now();

        const filterLogger = opts.logger?.child({
          emitterChain: filter.emitterChain,
          emitterAddress: filter.emitterAddress,
        });

        try {
          const results = await runMissedVaaCheck(
            filter,
            redis,
            app.processVaa.bind(app),
            opts,
            prefix,
            wormholescan,
            filterLogger,
          );
          updateMetrics(
            metrics,
            filter,
            startTime,
            false,
            results.missedVaas,
            results.sequenceStats,
          );
        } catch (error) {
          filterLogger?.error(
            `Error checking for missed vaas for filter: ${JSON.stringify(
              filter,
            )}}`,
            error,
          );

          updateMetrics(metrics, filter, startTime, true);
        }
      }),
    );

    await sleep(opts.checkInterval || 30_000);
  }
}

export async function runMissedVaaCheck(
  filter: FilterIdentifier,
  redis: Redis | Cluster,
  processVaa: ProcessVaaFn,
  opts: MissedVaaOpts,
  storagePrefix: string,
  wormholescan: Wormholescan,
  logger?: Logger,
) {
  const { emitterChain, emitterAddress } = filter;

  const previousSafeSequence = await tryGetLastSafeSequence(
    redis,
    storagePrefix,
    emitterChain,
    emitterAddress,
    logger,
  );

  const missedVaas: MissedVaaRunStats = await checkForMissedVaas(
    filter,
    redis,
    processVaa,
    opts,
    storagePrefix,
    wormholescan,
    previousSafeSequence,
    logger,
  );

  // TODO: this is an ugly way to handle the error
  const failedToFetchSequencesOrError = await tryGetExistingFailedSequences(
    redis,
    filter,
    storagePrefix,
  );

  if (!Array.isArray(failedToFetchSequencesOrError)) {
    logger?.error(
      `Failed to get existing failed sequences from redis. Error: `,
      failedToFetchSequencesOrError,
    );
  } else if (failedToFetchSequencesOrError.length) {
    logger?.warn(
      `Found sequences that we failed to get from wormhole-rpc. Sequences: ` +
        JSON.stringify(failedToFetchSequencesOrError),
    );
  } else {
    logger?.debug("No previous failed sequences found.");
  }

  const failedToFetchSequences = Array.isArray(failedToFetchSequencesOrError)
    ? failedToFetchSequencesOrError
    : null;

  const sequenceStats = calculateSequenceStats(
    missedVaas,
    failedToFetchSequences,
    previousSafeSequence?.toString(),
  );

  const { lastSafeSequence, lastSeenSequence, firstSeenSequence } =
    sequenceStats;

  if (
    !previousSafeSequence ||
    previousSafeSequence?.toString() !== String(lastSafeSequence)
  ) {
    logger?.debug(
      `No missing sequences found up to sequence ${lastSafeSequence}. Setting as last sequence`,
    );
    await trySetLastSafeSequence(
      redis,
      storagePrefix,
      emitterChain,
      emitterAddress,
      lastSafeSequence,
    );
  }

  const vaasFound =
    missedVaas.missingSequences.length + missedVaas.lookAheadSequences.length;

  logger?.info(
    `Finished missed VAAs check. Found: ${vaasFound}. Enable debug to see a log with precise results.`,
  );

  logger?.debug(
    `Finished missed vaas check. Results: ${JSON.stringify({
      missedVaas,
      lastSafeSequence,
      lastSeenSequence,
      firstSeenSequence,
    })}}`,
  );

  return { missedVaas, sequenceStats };
}

function createRedisPool(opts: RedisConnectionOpts): Pool<Redis | Cluster> {
  const factory = {
    create: async function () {
      const redis = opts.redisCluster
        ? new Redis.Cluster(opts.redisClusterEndpoints!, opts.redisCluster)
        : new Redis(opts.redis!);
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
