import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import Redis, { Cluster } from "ioredis";
import { Registry } from "prom-client";
import { ChainId, getSignedVAAWithRetry } from "@certusone/wormhole-sdk";
import { Pool } from "generic-pool";
import { Logger } from "winston";
import { GetSignedVAAResponse } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";

import {
  defaultWormholeRpcs,
  ParsedVaaWithBytes,
  RelayerApp,
  RelayerEvents,
  SerializableVaaId,
} from "../../application";
import { mapConcurrent, sleep } from "../../utils";
import { RedisConnectionOpts } from "../../storage/redis-storage";

import { initMetrics, MissedVaaMetrics } from "./metrics";
import {
  MissedVaaRunStats,
  calculateSequenceStats,
  updateMetrics,
} from "./helpers";
import {
  createRedisPool,
  markVaaAsSeen,
  deleteExistingSeenVAAsData,
  updateSeenSequences,
  trySetLastSafeSequence,
  tryGetLastSafeSequence,
  tryGetExistingFailedSequences,
  getAllProcessedSeqsInOrder,
  getSeenVaaKey,
  getFailedToFetchKey,
} from "./storage";

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

type ProcessVaaFn = (x: Buffer) => Promise<void>;

let metrics: MissedVaaMetrics;

export function spawnMissedVaaWorker(
  app: RelayerApp<any>,
  opts: MissedVaaOpts,
): void {
  opts.wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[app.env];
  if (!metrics) {
    metrics = opts.registry ? initMetrics(opts.registry) : {};
  }

  const redisPool = createRedisPool(opts);

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
        `Failed to acquire redis client while trying to mark vaa seen.`,
        error,
      );
      await redisPool.release(redis);
      return;
    }

    try {
      await markVaaAsSeen(redis, vaa.id, opts);
    } catch (error) {
      opts.logger?.error(
        `Failed to mark VAA ass seen ${vaa.id.sequence}. Vaa will probably be reprocessed. Error: `,
        error,
      );
    } finally {
      await redisPool.release(redis);
    }
  }

  app.addListener(RelayerEvents.Added, markVaaSeen);
  app.addListener(RelayerEvents.Skipped, markVaaSeen);
}

async function startMissedVaasWorkers(
  filters: FilterIdentifier[],
  redisPool: Pool<Cluster | Redis>,
  processVaa: ProcessVaaFn,
  opts: MissedVaaOpts,
) {
  if (opts.storagePrefix && opts.forceSeenKeysReindex) {
    await deleteExistingSeenVAAsData(filters, redisPool, opts);
  }
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
        const { storagePrefix } = opts;
        const { emitterChain, emitterAddress } = filter;
        const filterLogger = opts.logger?.child({
          emitterChain,
          emitterAddress,
        });

        const startTime = Date.now();
        const redis = await redisPool.acquire();

        const previousSafeSequence = await tryGetLastSafeSequence(
          redis,
          storagePrefix,
          emitterChain,
          emitterAddress,
          filterLogger,
        );

        let missedVaas: MissedVaaRunStats;

        try {
          missedVaas = await checkForMissedVaas(
            filter,
            redis,
            processVaa,
            opts,
            previousSafeSequence,
            filterLogger,
          );
        } catch (error) {
          opts.logger?.error(
            `Error checking for missed vaas for filter: ${JSON.stringify(
              filter,
            )}}`,
            error,
          );

          metrics.workerFailedRuns?.labels().inc();
          metrics.workerRunDuration?.labels().observe(Date.now() - startTime);

          return;
        }

        redisPool.release(redis);

        metrics.workerSuccessfulRuns?.labels().inc();
        metrics.workerRunDuration?.labels().observe(Date.now() - startTime);

        // TODO: this is an ugly way to handle the error
        const failedToFetchSequencesOrError =
          await tryGetExistingFailedSequences(redis, filter, opts);
        if (!Array.isArray(failedToFetchSequencesOrError)) {
          filterLogger?.error(
            `Failed to get existing failed sequences from redis.`,
          );
        } else if (failedToFetchSequencesOrError.length) {
          filterLogger?.warn(
            `Found sequences that we failed to get from wormhole-rpc. Sequences: ` +
              JSON.stringify(failedToFetchSequencesOrError),
          );
        } else {
          filterLogger?.debug("No previous failed sequences found.");
        }

        const failedToFetchSequences = Array.isArray(
          failedToFetchSequencesOrError,
        )
          ? failedToFetchSequencesOrError
          : null;

        const sequenceStats = calculateSequenceStats(
          missedVaas,
          failedToFetchSequences,
          previousSafeSequence?.toString(),
        );

        const { lastSafeSequence, lastSeenSequence, firstSeenSequence } =
          sequenceStats;

        if (lastSafeSequence > 0 && failedToFetchSequences !== null) {
          filterLogger?.debug(
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

        updateMetrics(metrics, filter, missedVaas, sequenceStats);

        const vaasFound =
          missedVaas.missingSequences.length +
          missedVaas.lookAheadSequences.length;

        filterLogger?.info(
          `Finished missed VAAs check. Found: ${vaasFound}. Enable debug to see a log with precise results.`,
        );

        filterLogger?.debug(
          `Finished missed vaas check. Results: ${JSON.stringify({
            missedVaas,
            lastSafeSequence,
            lastSeenSequence,
            firstSeenSequence,
          })}}`,
        );
      },
      opts.concurrency || 1,
    );

    // TODO: if possible handle this in a more event driven way (intervals + locks on a per chain basis)
    await sleep(opts.checkInterval || 30_000);
  }
}

async function checkForMissedVaas(
  filter: FilterIdentifier,
  redis: Cluster | Redis,
  processVaa: ProcessVaaFn,
  opts: MissedVaaOpts,
  previousSafeSequence?: bigint,
  logger?: Logger,
): Promise<MissedVaaRunStats> {
  const { storagePrefix } = opts;
  const { emitterChain, emitterAddress } = filter;
  const startingSeqConfig =
    opts.startingSequenceConfig?.[emitterChain as ChainId];

  const seenSequences = await getAllProcessedSeqsInOrder(
    redis,
    storagePrefix,
    emitterChain,
    emitterAddress,
    previousSafeSequence,
  );

  const processed: string[] = [];
  const failedToRecover: string[] = [];
  const failedToReprocess: string[] = [];
  let missingSequences: bigint[] = [];

  if (seenSequences.length) {
    const first = seenSequences[0];
    const last = seenSequences[seenSequences.length - 1];
    logger?.info(
      `Scanning sequences from ${first} to ${last} for missing sequences`,
    );
    // Check if there is any leap between the sequences seen,
    // and try reprocessing them if any:
    missingSequences = await scanForSequenceLeaps(seenSequences);

    const pipeline = redis.pipeline();
    let pipelineTouched = false;

    await mapConcurrent(
      missingSequences,
      async sequence => {
        const vaa = {
          ...filter,
          sequence: sequence.toString(),
        } as SerializableVaaId;
        const seenVaaKey = getSeenVaaKey(
          storagePrefix,
          emitterChain,
          emitterAddress,
        );
        const failedToFetchKey = getFailedToFetchKey(
          storagePrefix,
          emitterChain,
          emitterAddress,
        );
        const seqString = sequence.toString();

        let vaaResponse;
        try {
          vaaResponse = await tryFetchVaa(vaa, opts, opts.fetchVaaRetries);
          if (!vaaResponse) {
            // this is a sequence that we found in the middle of two other sequences we processed,
            // so we can consider this VAA not existing an error.
            throw new Error("VAA Sequence not found.");
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
          logger?.error(
            `Error fetching VAA for missing sequence ${sequence}`,
            error,
          );
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
          // If you see this log while troubleshooting, it probably means that there is an issue on the
          // relayer side since the VAA was successfully fetched but failed to be processed.
          logger?.error(
            `Failed to reprocess vaa found missing. ${seqString}`,
            error,
          );
          failedToReprocess.push(seqString);
        }
      },
      opts.vaasFetchConcurrency,
    );

    if (pipelineTouched) {
      try {
        await pipeline.exec();
      } catch (error) {
        logger?.error(
          "Some VAAs were processed but failed to be marked as seen: ",
          error,
        );
      }
    }
  }

  // look ahead of greatest seen sequence in case the next vaa was missed
  // continue looking ahead until a vaa can't be fetched
  const lastSeq = seenSequences[seenSequences.length - 1];

  let lookAheadSequence =
    lastSeq && startingSeqConfig
      ? lastSeq > startingSeqConfig
        ? lastSeq
        : startingSeqConfig // same as Math.max, which doesn't support bigint
      : lastSeq || startingSeqConfig;

  logger?.info(
    `Looking ahead for missed VAAs from sequence: ${lookAheadSequence}`,
  );

  const lookAheadSequences: string[] = [];
  if (lookAheadSequence) {
    for (let seq = lookAheadSequence + 1n; true; seq++) {
      const vaaKey = {
        ...filter,
        sequence: seq.toString(),
      } as SerializableVaaId;

      let vaa: GetSignedVAAResponse;
      try {
        vaa = await tryFetchVaa(vaaKey, opts, 3);
      } catch (error) {
        logger?.error(
          `Error FETCHING Look Ahead VAA. Sequence ${seq}. Error: `,
          error,
        );
      }

      if (!vaa) break;

      lookAheadSequences.push(seq.toString());

      logger?.info(`Found Look Ahead VAA. Sequence: ${seq.toString()}`);

      try {
        await processVaa(Buffer.from(vaa.vaaBytes));
        lookAheadSequence = seq;
        processed.push(seq.toString());
      } catch (error) {
        logger?.error(
          `Error PROCESSING Look Ahead VAA. Sequence: ${seq.toString()}. Error:`,
          error,
        );
      }
    }
  } else {
    logger?.warn(
      `No VAAs seen and no starting sequence was configured. Won't look ahead for missed VAAs.`,
    );
  }

  return {
    processed,
    failedToRecover,
    failedToReprocess,
    lookAheadSequences,
    seenSequences: seenSequences.map((s: bigint) => s.toString()),
    missingSequences: missingSequences.map(s => s.toString()),
  };
}

async function scanForSequenceLeaps(seenSequences: bigint[]) {
  const missing: bigint[] = [];
  let idx = 0;
  let nextSeen = seenSequences[0];
  for (
    let seq = seenSequences[0];
    seq < seenSequences[seenSequences.length - 1];
    seq++
  ) {
    if (seq === nextSeen) {
      nextSeen = seenSequences[++idx];
      continue;
    }
    missing.push(seq);
  }
  return missing;
}

async function tryFetchVaa(
  vaaKey: SerializableVaaId,
  opts: MissedVaaOpts,
  retries: number = 2,
): Promise<GetSignedVAAResponse> {
  let vaa;
  const stack = new Error().stack;
  try {
    vaa = await getSignedVAAWithRetry(
      opts.wormholeRpcs,
      vaaKey.emitterChain as ChainId,
      vaaKey.emitterAddress,
      vaaKey.sequence,
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
