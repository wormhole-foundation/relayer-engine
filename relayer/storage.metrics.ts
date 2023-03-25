import { Gauge, Histogram, Registry } from "prom-client";

export function createStorageMetrics(
  storageRegistry: Registry = new Registry()
) {
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
      processedDuration: new Histogram({
        name: `worklow_processing_duration`,
        help: "Processing time for completed jobs (processing until completed)",
        buckets: [5, 50, 100, 250, 500, 750, 1000, 2500],
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
      completedDuration: new Histogram({
        name: `workflow_total_duration`,
        help: "Completion time for jobs (created until completed)",
        buckets: [5, 50, 100, 250, 500, 750, 1000, 2500, 5000, 10000],
        labelNames: ["queue"],
        registers: [storageRegistry],
      }),
    },
  };
}
