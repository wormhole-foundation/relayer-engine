import { Gauge } from "prom-client";
import { Storage } from "./storage";

export const pluginsConfiguredGauge = new Gauge({
  name: "plugins_configured",
  help: "Number of plugins configured in the host.",
});

export const spyConnectionsGauge = new Gauge({
  name: "spy_connections_open",
  help: "Number of open connections to the wormhole spy",
});

export function registerGauges(storage: Storage, numPlugins: number) {
  pluginsConfiguredGauge.set(numPlugins);
  new Gauge({
    name: "enqueued_workflows",
    help: "Count of workflows waiting to be executed.",
    async collect() {
      // Invoked when the registry collects its metrics' values.
      const currentValue = await storage.numEnqueuedWorkflows();
      this.set(currentValue);
    },
  });

  new Gauge({
    name: "delayed_workflows",
    help: "Count of workflows waiting to be requeued after erroring out.",
    async collect() {
      // Invoked when the registry collects its metrics' values.
      const currentValue = await storage.numDelayedWorkflows();
      this.set(currentValue);
    },
  });

  new Gauge({
    name: "failed_workflows",
    help: "Count of workflows in the dead letter queue.",
    async collect() {
      // Invoked when the registry collects its metrics' values.
      const currentValue = await storage.numFailedWorkflows();
      this.set(currentValue);
    },
  });
}
