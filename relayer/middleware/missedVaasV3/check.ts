import Redis, { Cluster } from "ioredis";
import { ChainId } from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import { GetSignedVAAResponse } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";

import { SerializableVaaId } from "../../application";
import { mapConcurrent } from "../../utils";
import { MissedVaaRunStats, tryFetchVaa } from "./helpers";
import {
  getAllProcessedSeqsInOrder,
  calculateStartingIndex,
  batchMarkAsFailedToRecover,
  batchMarkAsSeen,
} from "./storage";
import { FilterIdentifier, MissedVaaOpts } from "./worker";

export type ProcessVaaFn = (x: Buffer) => Promise<void>;

export async function checkForMissedVaas(
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

  const startingIndex = await calculateStartingIndex(
    redis,
    storagePrefix,
    emitterChain,
    emitterAddress,
    previousSafeSequence,
    startingSeqConfig,
    logger,
  );

  const seenSequences = await getAllProcessedSeqsInOrder(
    redis,
    storagePrefix,
    emitterChain,
    emitterAddress,
    startingIndex,
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
          await processVaa(vaaResponse.vaaBytes);
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

    if (failedToRecover.length)
      await batchMarkAsFailedToRecover(
        redis,
        storagePrefix,
        emitterChain,
        emitterAddress,
        failedToRecover,
      );

    const allSeenVaas = processed.concat(failedToRecover);
    if (allSeenVaas.length)
      await batchMarkAsSeen(
        redis,
        storagePrefix,
        emitterChain,
        emitterAddress,
        allSeenVaas,
      );
  }

  // look ahead of greatest seen sequence in case the next vaa was missed
  // continue looking ahead until a vaa can't be fetched
  const lastSeq = seenSequences[seenSequences.length - 1]
    ? seenSequences[seenSequences.length - 1] + 1n
    : null;

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
    for (let seq = lookAheadSequence; true; seq++) {
      const vaaKey = {
        ...filter,
        sequence: seq.toString(),
      } as SerializableVaaId;

      let vaa: GetSignedVAAResponse;
      try {
        vaa = await tryFetchVaa(vaaKey, opts.wormholeRpcs, 3);
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
        // since we add this VAA to the queue, there's no need to mark it as seen
        // (it will be automatically marked as seen when the "added" event is fired)
        await processVaa(Buffer.from(vaa.vaaBytes));
        lookAheadSequence = seq + 1n;
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
