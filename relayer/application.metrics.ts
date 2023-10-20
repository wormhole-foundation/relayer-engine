import { Counter, Gauge, Registry } from "prom-client";

export interface RelayerMetrics {
  connectedSpies: Gauge<string>;
  lastVaaReceived: Gauge<string>;
  vaasViaSpyTotal: Counter<string>;
  spySubscribedFilters: Gauge<string>;
}

export function createRelayerMetrics(
  relayerRegistry: Registry = new Registry(),
): { registry: Registry; metrics: RelayerMetrics } {
  return {
    registry: relayerRegistry,
    metrics: {
      connectedSpies: new Gauge({
        name: `connected_spies`,
        help: "Total number of spies connected the relayer is connected to. For now this is always 1 or 0.",
        labelNames: ["queue"],
        registers: [relayerRegistry],
      }),
      lastVaaReceived: new Gauge({
        name: `last_vaa_received_at`,
        help: "Date in ms since epoch of when the last VAA was received",
        labelNames: ["queue"],
        registers: [relayerRegistry],
      }),
      vaasViaSpyTotal: new Counter({
        name: `vaa_via_spy_total`,
        help: "Total number of VAAs received via the spy. If the same vaa is received multiple times, it will be counted multiple times.",
        labelNames: ["queue"],
        registers: [relayerRegistry],
      }),
      spySubscribedFilters: new Gauge({
        name: `spy_subscribed_filter_count`,
        help: "Number of Filters passed in to the Spy. This is the number of contracts the relayer is watching.",
        labelNames: ["queue"],
        registers: [relayerRegistry],
      }),
    },
  };
}
