import { coalesceChainName, ChainId } from "@certusone/wormhole-sdk";
import { FilterIdentifier } from "./worker";
import { MissedVaaMetrics } from "./metrics";

export type MissedVaaRunStats = {
  processed: string[],
  seenSequences: string[],
  failedToRecover: string[],
  failedToReprocess: string[],
  lookAheadSequences: string[],
  missingSequences: string[],
};

export type SequenceStats = {
  lastSafeSequence: number,
  lastSeenSequence: number,
  firstSeenSequence: number,
};

export function calculateSequenceStats(
  runStats: MissedVaaRunStats,
  failedToFetchSequences: string[],
  previousSafeSequence: string
): SequenceStats {
  const { seenSequences } = runStats;

  const lastSafeSequence = calculateLastSafeSequence(runStats, failedToFetchSequences, previousSafeSequence);
  const lastSeenSequence = Math.max(Number(seenSequences[seenSequences.length - 1]), lastSafeSequence);
  const firstSeenSequence = Number(seenSequences[0]) || 0;

  return { lastSafeSequence, lastSeenSequence, firstSeenSequence}
}

function calculateLastSafeSequence (
  runStats: MissedVaaRunStats,
  failedToFetchSequences: string[],
  previousSafeSequence: string
): number {
  if (failedToFetchSequences && failedToFetchSequences.length > 0) {
    // we have sequences that we have failed to update before. We won't update the last
    // safe sequence. Return the previous one, or 0 if there is none.
    return Number(previousSafeSequence) || 0;
  };

  const { missingSequences, failedToRecover, failedToReprocess } = runStats;

  const missingSequencesFailedToReprocess = failedToRecover.length === 0
    && failedToReprocess.length === 0;

  if (missingSequences.length > 0 && missingSequencesFailedToReprocess) {
    // we found some missing sequences on this run, but we were able to reprocess them
    // return the previous safe sequence, or 0 if there is none.
    return Math.min(...missingSequences.map((seq) => Number(seq))) - 1;
  }

  // No missing sequences up to seenSequences
  // if the there was vaas recovered by the lookahead, use that as the
  // last safe sequence. Otherwise, use the last seen sequence.
  const lastSafeSequence = runStats.lookAheadSequences.length > 0
    ? runStats.lookAheadSequences[runStats.lookAheadSequences.length - 1]
    : runStats.seenSequences[runStats.seenSequences.length - 1];

  return Number(lastSafeSequence) || 0;
}

export function updateMetrics(
  metrics: MissedVaaMetrics,
  filter: FilterIdentifier,
  missedVaas: MissedVaaRunStats,
  sequenceStats: SequenceStats,
  ) {
  const { emitterChain, emitterAddress } = filter;
  const vaasProcessed = missedVaas.processed?.length || 0;
  // This are VAAs that were found missing between known sequences, but we failed
  // to fetch them to reprocess them
  const vaasFailedToRecover = missedVaas.failedToRecover?.length || 0;
  // This are VAAs that were found but failed when trying to re-queue them
  const vaasFailedToReprocess = missedVaas.failedToReprocess?.length || 0;

  const vaasFound = vaasProcessed + vaasFailedToReprocess;

  const labels = { emitterChain: coalesceChainName(emitterChain as ChainId), emitterAddress };
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

  const { lastSeenSequence, lastSafeSequence, firstSeenSequence } = sequenceStats;

  metrics.lastSeenSequence?.labels(labels).set(lastSeenSequence);
  metrics.lastSafeSequence?.labels(labels).set(lastSafeSequence);
  metrics.firstSeenSequence?.labels(labels).set(firstSeenSequence);
  metrics.missingSequences?.labels(labels).set(missedVaas.missingSequences.length ? 1 : 0);
}
