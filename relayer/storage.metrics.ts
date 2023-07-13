import { Counter, Gauge, Histogram, Registry } from "prom-client";

export interface StorageMetrics {
  delayedGauge: Gauge<string>;
  waitingGauge: Gauge<string>;
  activeGauge: Gauge<string>;
  failedGauge: Gauge<string>;
  completedCounter: Counter<string>;
  failedWithMaxRetriesCounter: Counter<string>;
  failedRunsCounter: Counter<string>;
  completedDuration: Histogram<string>;
  processedDuration: Histogram<string>;
}
export function createStorageMetrics(
  storageRegistry: Registry = new Registry(),
): { registry: Registry; metrics: StorageMetrics } {
  return {
    registry: storageRegistry,
    metrics: {
      activeGauge: new Gauge({
        name: `active_workflows`,
        help: "Total number of active jobs (currently being processed)",
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      delayedGauge: new Gauge({
        name: `delayed_workflows`,
        help: "Total number of jobs that will run in the future",
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      waitingGauge: new Gauge({
        name: `waiting_workflows`,
        help: "Total number of jobs waiting to be processed",
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      failedGauge: new Gauge({
        name: `failed_workflows`,
        help: "Total number of jobs currently in a failed state",
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      completedCounter: new Counter({
        name: `completed_workflows_total`,
        help: "Total number of completed jobs",
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      failedRunsCounter: new Counter({
        name: `failed_workflow_runs_total`,
        help: "Total number of failed job runs",
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      failedWithMaxRetriesCounter: new Counter({
        name: `failed_with_max_retries_workflows_total`,
        help: "Total number of jobs that failed after max retries. Eg: they will require manual intervention to succeed",
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      processedDuration: new Histogram({
        name: `worklow_processing_duration`,
        help: "Processing time in ms for completed jobs (processing until completed)",
        buckets: [6000, 7000, 7500, 8000, 8500, 9000, 10000, 12000],
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      completedDuration: new Histogram({
        name: `workflow_total_duration`,
        help: "Completion time in ms for jobs (created until completed)",
        buckets: [
          7500, 10000, 20000, 30000, 45000, 60000, 90000, 120000, 240000,
        ],
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
    },
  };
}
