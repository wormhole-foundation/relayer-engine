import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import {
  coalesceChainName,
  ChainId,
  getSignedVAAWithRetry,
} from "@certusone/wormhole-sdk";
import { GetSignedVAAResponse } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";

import { SerializableVaaId } from "../../application";
import { FilterIdentifier } from "./worker";
import { MissedVaaMetrics } from "./metrics";

export type MissedVaaRunStats = {
  processed: string[];
  seenSequences: string[];
  failedToRecover: string[];
  failedToReprocess: string[];
  lookAheadSequences: string[];
  missingSequences: string[];
};

export type SequenceStats = {
  lastSafeSequence: number;
  lastSeenSequence: number;
  firstSeenSequence: number;
};

export function calculateSequenceStats(
  runStats: MissedVaaRunStats,
  failedToFetchSequences: string[],
  previousSafeSequence?: string,
): SequenceStats {
  const { seenSequences } = runStats;

  const lastSafeSequence = calculateLastSafeSequence(
    runStats,
    failedToFetchSequences,
    previousSafeSequence,
  );
  const lastSeenSequence = Math.max(
    seenSequences.length ? Number(seenSequences[seenSequences.length - 1]) : 0,
    lastSafeSequence,
  );
  const firstSeenSequence = Number(seenSequences[0]) || 0;

  return { lastSafeSequence, lastSeenSequence, firstSeenSequence };
}

function calculateLastSafeSequence(
  runStats: MissedVaaRunStats,
  failedToFetchSequences: string[],
  previousSafeSequence?: string,
): number {
  if (failedToFetchSequences && failedToFetchSequences.length > 0) {
    // we have sequences that we have failed to update before. We won't update the last
    // safe sequence. Return the the last sequence before the first one we failed to fetch.
    return Number(failedToFetchSequences[0]) - 1;
  }

  const { missingSequences, failedToRecover, failedToReprocess } = runStats;

  const missingSequencesFailedToReprocess =
    failedToRecover.length > 0 || failedToReprocess.length > 0;

  if (missingSequences.length > 0 && missingSequencesFailedToReprocess) {
    // we found some missing sequences on this run, but we were able to reprocess them
    // return the previous safe sequence, or 0 if there is none.
    return Number(missingSequences[0]) - 1;
  }

  // No missing sequences up to seenSequences
  // if the there was vaas recovered by the lookahead, use that as the
  // last safe sequence. Otherwise, use the last seen sequence.
  const lastSeenSequence =
    runStats.lookAheadSequences.length > 0
      ? runStats.lookAheadSequences[runStats.lookAheadSequences.length - 1]
      : runStats.seenSequences[runStats.seenSequences.length - 1];

  return lastSeenSequence
    ? Number(lastSeenSequence)
    : previousSafeSequence
    ? Number(previousSafeSequence)
    : 0;
}

export function updateMetrics(
  metrics: MissedVaaMetrics,
  filter: FilterIdentifier,
  startTime: number, // timestamp in ms
  failure: boolean,
  missedVaas?: MissedVaaRunStats,
  sequenceStats?: SequenceStats,
) {
  const { emitterChain, emitterAddress } = filter;

  if (failure) {
    metrics.workerFailedRuns?.labels().inc();
    metrics.workerRunDuration?.labels().observe(Date.now() - startTime);
    return;
  }

  metrics.workerSuccessfulRuns?.labels().inc();
  metrics.workerRunDuration?.labels().observe(Date.now() - startTime);

  const vaasProcessed = missedVaas.processed.length;
  // This are VAAs that were found missing between known sequences, but we failed
  // to fetch them to reprocess them
  const vaasFailedToRecover = missedVaas.failedToRecover.length;
  // This are VAAs that were found but failed when trying to re-queue them
  const vaasFailedToReprocess = missedVaas.failedToReprocess.length;
  const vaasFound =
    missedVaas.missingSequences.length + missedVaas.lookAheadSequences.length;

  const labels = {
    emitterChain: coalesceChainName(emitterChain as ChainId),
    emitterAddress,
  };

  if (vaasFound > 0) {
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

  const { lastSeenSequence, lastSafeSequence, firstSeenSequence } =
    sequenceStats;

  metrics.lastSeenSequence?.labels(labels).set(lastSeenSequence);
  metrics.lastSafeSequence?.labels(labels).set(lastSafeSequence);
  metrics.firstSeenSequence?.labels(labels).set(firstSeenSequence);
  metrics.missingSequences
    ?.labels(labels)
    .set(missedVaas.missingSequences.length ? 1 : 0);
}

export async function tryFetchVaa(
  vaaKey: SerializableVaaId,
  wormholeRpcs: string[],
  retries: number = 2,
): Promise<GetSignedVAAResponse | null> {
  let vaa;
  const stack = new Error().stack;
  try {
    vaa = await getSignedVAAWithRetry(
      wormholeRpcs,
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
