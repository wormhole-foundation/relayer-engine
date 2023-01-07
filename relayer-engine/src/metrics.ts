import { Gauge } from "prom-client";

export const pluginsConfiguredGauge = new Gauge({
  name: "plugins_configured",
  help: "Number of plugins configured in the host.",
});
