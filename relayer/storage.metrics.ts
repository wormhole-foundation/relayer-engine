import { Gauge, Registry } from "prom-client";

export interface StorageMetrics {
  delayedGauge: Gauge<string>;
  waitingGauge: Gauge<string>;
  activeGauge: Gauge<string>;
  failedGauge: Gauge<string>;
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
    },
  };
}
