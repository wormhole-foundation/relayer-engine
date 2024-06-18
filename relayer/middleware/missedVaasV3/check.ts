import { Cluster, Redis } from "ioredis";
import { Logger } from "winston";
import { Pool } from "generic-pool";
import {
  ParsedVaaWithBytes,
  RelayerApp,
  RelayerEvents,
  SerializableVaaId,
} from "../../application.js";
import { mapConcurrent, max } from "../../utils.js";
import { MissedVaaRunStats, tryFetchVaa } from "./helpers.js";
import {
  batchMarkAsFailedToRecover,
  batchMarkAsSeen,
  calculateStartingIndex,
  deleteExistingSeenVAAsData,
  getAllProcessedSeqsInOrder,
  markVaaAsSeen,
  updateSeenSequences,
} from "./storage.js";
import { FilterIdentifier, MissedVaaOpts } from "./worker.js";
import { Wormholescan } from "../../rpc/wormholescan-client.js";
import { ChainId } from "@wormhole-foundation/sdk";

export type ProcessVaaFn = (x: Buffer) => Promise<void>;

export async function checkForMissedVaas(
  filter: FilterIdentifier,
  redis: Cluster | Redis,
  processVaa: ProcessVaaFn,
  opts: MissedVaaOpts,
  prefix: string,
  wormholescan: Wormholescan,
  previousSafeSequence?: bigint,
  logger?: Logger,
): Promise<MissedVaaRunStats> {
  const { emitterChain, emitterAddress } = filter;
  const startingSeqConfig =
    opts.startingSequenceConfig?.[emitterChain as ChainId];

  const startingIndex = await calculateStartingIndex(
    redis,
    prefix,
    emitterChain,
    emitterAddress,
    previousSafeSequence,
  );

  const seenSequences = await getAllProcessedSeqsInOrder(
    redis,
    prefix,
    emitterChain,
    emitterAddress,
    startingIndex,
    startingSeqConfig,
  );

  const processed: string[] = [];
  const failedToRecover: string[] = [];
  const failedToReprocess: string[] = [];
  let missingSequences: bigint[] = [];

  if (seenSequences.length > 0) {
    const first =
      previousSafeSequence !== undefined &&
      previousSafeSequence < seenSequences[0]
        ? previousSafeSequence
        : seenSequences[0];
    const last = seenSequences[seenSequences.length - 1];
    logger?.info(
      `Scanning sequences from ${first} to ${last} for missing sequences`,
    );
    // Check if there is any leap between the sequences seen,
    // and try reprocessing them if any:
    if (
      previousSafeSequence !== undefined &&
      previousSafeSequence < seenSequences[0]
    ) {
      seenSequences.unshift(previousSafeSequence);
    }
    missingSequences = scanForSequenceLeaps(seenSequences);

    await mapConcurrent(
      missingSequences,
      async sequence => {
        const vaa = {
          ...filter,
          sequence: sequence.toString(),
        } as SerializableVaaId;
        const seqString = sequence.toString();

        let vaaResponse;
        try {
          vaaResponse = await tryFetchVaa(
            vaa,
            opts.wormholeRpcs,
            opts.fetchVaaRetries,
          );
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
          return;
        }

        try {
          await processVaa(Buffer.from(vaaResponse));
          logger?.debug(`Recovered missing VAA ${seqString}`);

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
  }

  // look ahead of greatest seen sequence in case the next vaa was missed
  // continue looking ahead until a vaa can't be fetched
  const lastSeq =
    seenSequences.length > 0 ? seenSequences[seenSequences.length - 1] : null;

  const lookAheadSequence =
    lastSeq !== null && startingSeqConfig !== undefined
      ? max(lastSeq, startingSeqConfig)
      : lastSeq || startingSeqConfig;

  const {
    lookAheadSequences,
    processed: processedLookAhead,
    failedToRecover: failedToRecoverLookAhead,
  } = await lookAhead(
    lookAheadSequence,
    filter,
    wormholescan,
    opts.fetchVaaRetries,
    opts.maxLookAhead,
    processVaa,
    logger,
  );

  processed.push(...processedLookAhead);
  failedToRecover.push(...failedToRecoverLookAhead);

  if (failedToRecover.length)
    await batchMarkAsFailedToRecover(
      redis,
      prefix,
      emitterChain,
      emitterAddress,
      failedToRecover,
    );

  if (processed.length)
    await batchMarkAsSeen(
      redis,
      prefix,
      emitterChain,
      emitterAddress,
      processed,
    );

  return {
    processed,
    failedToRecover,
    failedToReprocess,
    lookAheadSequences,
    seenSequences: seenSequences.map((s: bigint) => s.toString()),
    missingSequences: missingSequences.map(s => s.toString()),
  };
}

export async function refreshSeenSequences(
  redisPool: Pool<Redis | Cluster>,
  filters: FilterIdentifier[],
  opts: MissedVaaOpts,
) {
  await redisPool.use(async redis => {
    if (opts.storagePrefix && opts.forceSeenKeysReindex) {
      await deleteExistingSeenVAAsData(
        filters,
        redis,
        opts.storagePrefix,
        opts.logger,
      );
    }

    // The prefix used by the storage to store workflows.
    // We'll use it to go into the queue, and build a map of what
    // sequences have already been processed according to the store
    if (opts.storagePrefix) {
      const startTime = Date.now();
      const scannedKeys = await updateSeenSequences(
        filters,
        redis,
        opts.storagePrefix,
      );
      const elapsedTime = Date.now() - startTime;

      opts.logger?.info(`Scanned ${scannedKeys} keys in ${elapsedTime}ms`);
    }
  });
}

export async function registerEventListeners(
  app: RelayerApp<any>,
  redisPool: Pool<Redis | Cluster>,
  opts: MissedVaaOpts,
  prefix: string,
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
      return;
    }

    try {
      await markVaaAsSeen(redis, vaa.id, prefix);
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

async function lookAhead(
  lastSeenSequence: bigint | undefined,
  filter: FilterIdentifier,
  wormholescan: Wormholescan,
  maxRetries: number | undefined,
  maxLookAhead: number = 10,
  processVaa: ProcessVaaFn,
  logger?: Logger,
) {
  const lookAheadSequences: string[] = [];
  const processed: string[] = [];
  let failedToRecover: string[] = [];
  if (lastSeenSequence === undefined) {
    logger?.warn(
      `No VAAs seen and no starting sequence was configured. Won't look ahead for missed VAAs.`,
    );

    return { lookAheadSequences, processed, failedToRecover };
  }

  logger?.info(
    `Looking ahead for missed VAAs from sequence: ${lastSeenSequence}`,
  );

  const latestVaas = await wormholescan.listVaas(
    filter.emitterChain,
    filter.emitterAddress,
    { pageSize: maxLookAhead, retries: maxRetries },
  );
  if ("error" in latestVaas) {
    logger?.error(
      `Error FETCHING Look Ahead VAAs. Error: ${latestVaas.error.message}`,
      latestVaas.error,
    );
    throw latestVaas.error;
  }

  // latestVaas.data is sorted DESC based on timestamp, so we sort ASC by sequence
  const vaas = latestVaas.data
    .filter(vaa => vaa.sequence > lastSeenSequence)
    .sort((a, b) => Number(a.sequence - b.sequence));

  if (vaas.length === 0) {
    logger?.debug(`No Look Ahead VAAs found.`);
    return { lookAheadSequences, processed, failedToRecover };
  }

  logger?.debug(
    `Found ${vaas.length} Look Ahead VAAs. From ${vaas[0].sequence} to ${
      vaas[vaas.length - 1].sequence
    }`,
  );

  let lastVisitedSequence = BigInt(lastSeenSequence);

  for (const vaa of vaas) {
    lookAheadSequences.push(vaa.sequence.toString());
    const sequenceGap = BigInt(vaa.sequence) - lastVisitedSequence;
    if (sequenceGap > 0) {
      const missing = Array.from({ length: Number(sequenceGap - 1n) }, (_, i) =>
        (lastVisitedSequence + BigInt(i + 1)).toString(),
      );
      failedToRecover = failedToRecover.concat(missing);
    }

    try {
      // since we add this VAA to the queue, there's no need to mark it as seen
      // (it will be automatically marked as seen when the "added" event is fired)
      await processVaa(vaa.vaa);
      processed.push(vaa.sequence.toString());
    } catch (error) {
      logger?.error(
        `Error PROCESSING Look Ahead VAA. Sequence: ${vaa.sequence.toString()}. Error:`,
        error,
      );
    }

    lastVisitedSequence = BigInt(vaa.sequence);
  }

  return { lookAheadSequences, processed, failedToRecover };
}

function scanForSequenceLeaps(seenSequences: bigint[]) {
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
