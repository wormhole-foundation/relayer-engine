import { beforeEach, describe, test } from "@jest/globals";
import { Registry } from "prom-client";
import {
  MetricLabelsOpts,
  metrics,
  MetricsOpts,
} from "../../relayer/middleware/metrics.middleware";
import { Middleware, Next } from "../../relayer/compose.middleware";
import { parseVaa } from "@certusone/wormhole-sdk";
import { StorageContext } from "../../relayer/storage/storage";
import { ParsedVaaWithBytes } from "../../relayer/application";
import { Environment } from "../../relayer/environment";

type TestContext = StorageContext & { target?: string };

const vaa = Buffer.from(
  "AQAAAAABAGYGQ1g8mB5UMkeq28zodCdhDUk8YSjRSseFmP3VkKHMDUuZmDpQ6ccsPSx+bUkDIDp+ud6Qfes9nvZcWHkH1tQAZNPDWAg9AQAAAgAAAAAAAAAAAAAAAPiQmC+TEN9X0A9lnPT9h+Za3tjXAAAAAAACh1YBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPoAAAAAAAAAAAAAAAAtPvycRQ/T797kaXe0xgF5CsiCNYAAgAAAAAAAAAAAAAAAI8moAJdzMbPwHp9OHVigKEOKVrXAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  "base64",
);
const targetLabel = "targetLabel";

let ctx: TestContext;
let middleware: Middleware<TestContext> | null;
const registry: Registry = new Registry();
let labelOpts: MetricLabelsOpts<TestContext>;
let next: Next;

describe("metrics middleware", () => {
  beforeEach(() => {
    registry.clear();
    middleware = null;
  });

  test("should expose known metrics", async () => {
    givenAMetricsMiddleware();
    givenAContext();
    const next = nextProvider();

    await whenExecuted(next);

    thenNextCalled(next);
    await thenMetricPresent("vaas_processed_total", val => expect(val).toBe(1));
    await thenMetricPresent(
      "vaas_finished_total",
      val => expect(val).toBe(1),
      true,
    );
  });

  test("should expose time histogram", async () => {
    givenAMetricsMiddleware();
    givenAContext();

    await whenExecuted(nextProvider());

    await thenMetricPresent(
      "vaas_processing_duration",
      val => expect(val).toBeGreaterThan(0),
      true,
    );
  });

  test("should allow to customize labels", async () => {
    const expectedTarget = "base";
    givenAMetricsMiddleware({
      labels: { labelNames: [targetLabel], customizer: targetCustomizer },
    });
    givenAContext();

    await whenExecuted(
      nextProvider(() => {
        ctx.target = expectedTarget;
      }),
    );

    await thenMetricPresent(
      "vaas_processing_duration",
      (val, labels) => {
        expect(val).toBeGreaterThan(0);
        expect(labels[targetLabel]).toBe(expectedTarget);
      },
      true,
    );
  });

  test("should measure failures", async () => {
    const expectedTarget = "celo";
    givenAMetricsMiddleware({
      labels: { labelNames: [targetLabel], customizer: targetCustomizer },
    });
    givenAContext();

    await whenExecuted(
      nextProvider(() => {
        ctx.target = expectedTarget;
        throw new Error("runtime failure");
      }),
    );

    await thenMetricPresent(
      "vaas_finished_total",
      (val, labels) => {
        expect(val).toBe(1);
        expect(labels.status).toBe("failed");
        expect(labels.terminal).toBe("true");
        expect(labels[targetLabel]).toBe(expectedTarget);
      },
      false,
    );
    await thenMetricPresent(
      "vaas_processing_duration",
      (val, labels) => {
        expect(val).toBeGreaterThan(0);
        expect(labels.status).toBe("failed");
        expect(labels[targetLabel]).toBe(expectedTarget);
      },
      false,
    );
  });
});

const createContext = () => ({
  storage: { job: createRelayJob() },
  locals: {},
  fetchVaa: () => Promise.resolve({} as ParsedVaaWithBytes),
  fetchVaas: () => Promise.resolve([]),
  processVaa: () => Promise.resolve(),
  config: { spyFilters: [{}] },
  env: Environment.DEVNET,
  on: () => {},
});

const targetCustomizer = (ctx: TestContext) =>
  Promise.resolve({ targetLabel: ctx.target ?? 0 });

const createRelayJob = () => ({
  id: "id",
  name: "name",
  data: {
    vaaBytes: vaa,
    parsedVaa: parseVaa(vaa),
  },
  attempts: 1,
  maxAttempts: 1,
  log: (logRow: string) => Promise.resolve(5),
  updateProgress: (progress: number | object) => Promise.resolve(),
});

const nextProvider: (implementation?: () => void) => Next = (
  implementation = () => {},
) => jest.fn().mockImplementation(() => Promise.resolve(implementation()));

const givenAMetricsMiddleware = (opts: MetricsOpts<TestContext> = {}) => {
  middleware = metrics<TestContext>({ registry, ...opts });
};

const givenAContext = () => (ctx = createContext());

const whenExecuted = async (next: Next) => {
  try {
    await middleware!(ctx, next);
  } catch (error) {
    // ignoring it
  }
};

const thenMetricPresent = async (
  metric: string,
  expectation: (
    value: any,
    labels: Partial<Record<string, string | number>>,
  ) => void,
  withStatus: boolean = false,
) => {
  const metricValue = (await registry.getSingleMetric(metric)!.get()).values[0];
  expect(metricValue).toBeDefined();
  expectation(metricValue.value, metricValue.labels);
  if (withStatus) {
    expect(metricValue.labels["status"]).toBeDefined();
  }
  labelOpts?.labelNames!.forEach(labelName =>
    expect(metricValue.labels[labelName]).toBeDefined(),
  );
};

const thenNextCalled = (next: Next) => {
  expect(next).toHaveBeenCalledTimes(1);
};
