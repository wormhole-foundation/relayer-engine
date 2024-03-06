import { beforeEach, describe, test, jest } from "@jest/globals";
import { MetricValue, Registry } from "prom-client";
import {
  MetricLabelsOpts,
  metrics,
  MetricsOpts,
} from "../../relayer/middleware/metrics.middleware.js";
import { Middleware, Next } from "../../relayer/compose.middleware.js";
import { StorageContext } from "../../relayer/storage/storage.js";
import { ParsedVaaWithBytes } from "../../relayer/application.js";
import { Environment } from "../../relayer/environment.js";
import { sleep } from "../../relayer/utils.js";
import { VaaFactory } from "../vaa-factory.js";
import { deserialize } from "@wormhole-foundation/sdk";

type TestContext = StorageContext & { target?: string };

const vaa = VaaFactory.getVaa();
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
    await thenMetricPresent("vaas_processed_total", values =>
      expect(values[0].value).toBe(1),
    );
    await thenMetricPresent(
      "vaas_finished_total",
      values => expect(values[0].value).toBe(1),
      true,
    );
  });

  test("should expose processing time histogram", async () => {
    givenAMetricsMiddleware();
    givenAContext();

    await whenExecuted(nextProvider());

    await thenMetricPresent(
      "vaas_processing_duration",
      values => expect(values[0].value).toBeGreaterThan(0),
      true,
    );
  });

  test("should expose total time histogram", async () => {
    givenAMetricsMiddleware();
    givenAContext();

    await whenExecuted(nextProvider());

    await thenMetricPresent(
      "vaas_total_duration",
      values =>
        expect(values.filter(val => val.value).length).toBeGreaterThan(0),
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
      (values, labels) => {
        expect(values[0].value).toBeGreaterThan(0);
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
      (values, labels) => {
        expect(values[0].value).toBe(1);
        expect(labels.status).toBe("failed");
        expect(labels.terminal).toBe("true");
        expect(labels[targetLabel]).toBe(expectedTarget);
      },
      false,
    );
    await thenMetricPresent(
      "vaas_processing_duration",
      (values, labels) => {
        expect(values[0].value).toBeGreaterThan(0);
        expect(labels.status).toBe("failed");
        expect(labels[targetLabel]).toBe(expectedTarget);
      },
      false,
    );
  });

  test("should allow to customize histogram buckets", async () => {
    const expectedTarget = "celo";
    const options = {
      buckets: { processing: [10, 100, 1000, 1500] },
    };
    givenAMetricsMiddleware(options);
    givenAContext();

    await whenExecuted(
      nextProvider(() => {
        ctx.target = expectedTarget;
      }),
    );

    await thenMetricPresent(
      "vaas_processing_duration",
      values => {
        expect(
          values
            .filter(
              value =>
                (value as any)["metricName"] ===
                "vaas_processing_duration_bucket",
            ) // ignore sum and count metrics
            .filter(value => (value.labels as any)["le"] != "+Inf") // ignore default bucket to catch everything beyond specified ones
            .map(value => (value.labels as any)["le"]),
        ).toStrictEqual(options.buckets.processing);
      },
      false,
    );
  });

  test("should measure relaying time", async () => {
    const processingOverhead = 5;
    givenAMetricsMiddleware();
    givenAContext();

    await whenExecuted(async () => {
      await sleep(processingOverhead);
    });

    await thenMetricPresent("vaas_relay_duration", (values, labels) => {
      expect(values[0].value).toBeGreaterThan(0);
    });
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
    parsedVaa: deserialize("Uint8Array", vaa),
  },
  attempts: 1,
  maxAttempts: 1,
  receivedAt: Date.now(),
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
    values: MetricValue<any>[],
    labels: Partial<Record<string, string | number>>,
  ) => void,
  withStatus: boolean = false,
) => {
  const metricValues = (await registry.getSingleMetric(metric)!.get()).values;
  expect(metricValues).toBeDefined();
  expectation(metricValues, metricValues[0].labels);
  if (withStatus) {
    expect(metricValues[0].labels["status"]).toBeDefined();
  }
  labelOpts?.labelNames!.forEach(labelName =>
    expect(metricValues[0].labels[labelName]).toBeDefined(),
  );
};

const thenNextCalled = (next: Next) => {
  expect(next).toHaveBeenCalledTimes(1);
};
