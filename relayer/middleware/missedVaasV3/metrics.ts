import { Registry, Counter, Histogram, Gauge } from "prom-client";

export type MissedVaaMetrics = {
  workerFailedRuns?: Counter;
  workerSuccessfulRuns?: Counter;
  recoveredVaas?: Counter;
  detectedVaas?: Counter;
  failedToReprocess?: Counter;
  failedToRecover?: Counter;
  workerRunDuration?: Histogram;
  workerWarmupDuration?: Histogram;
  lastSeenSequence?: Gauge;
  firstSeenSequence?: Gauge;
  lastSafeSequence?: Gauge;
  missingSequences?: Gauge;
};

export function initMetrics(registry: Registry): MissedVaaMetrics {
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
