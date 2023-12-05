import { Counter, Histogram, register, Registry } from "prom-client";
import { Middleware, Next } from "../compose.middleware.js";
import { RelayJob, StorageContext } from "../storage/storage.js";

type MetricRecord = Record<string, string | number>;
const defaultTimeBuckets = [6000, 7000, 7500, 8000, 8500, 9000, 10000, 12000];

class MeasuredRelayJob {
  private job?: RelayJob;
  private startTime: number;
  private endTime: number;

  constructor(startTime: number, endTime: number, job?: RelayJob) {
    this.job = job;
    this.startTime = startTime;
    this.endTime = endTime;
  }

  hasReachedMaxAttempts(): boolean {
    return this.currentAttempts() >= this.maxAttempts();
  }

  vaaTimestamp(): number {
    // vaa.timestamp is in seconds
    return (this.job?.data?.parsedVaa?.timestamp ?? 0) * 1000;
  }

  relayJobTimestamp(): number {
    return this.job?.receivedAt ?? 0;
  }

  processingTime(): number {
    return this.endTime - this.startTime;
  }

  /**
   * @returns the time in ms between the timestamp of the block the
   *          VAA message was published in and the processing end time
   */
  totalTime(): number {
    if (this.vaaTimestamp() > 0) {
      return this.endTime - this.vaaTimestamp();
    }

    return 0;
  }

  /**
   * @returns the time in ms between the relayer gets notified of the VAA and
   *          the processing end time
   */
  relayingTime(): number {
    if (this.relayJobTimestamp() > 0) {
      return this.endTime - this.relayJobTimestamp();
    }

    return 0;
  }

  private currentAttempts(): number {
    return this.job?.attempts ?? 0;
  }

  private maxAttempts(): number {
    return this.job?.maxAttempts ?? Number.MAX_SAFE_INTEGER;
  }
}

const status = "status";
const terminal = "terminal";

export interface MetricsOpts<C extends StorageContext> {
  registry?: Registry;
  labels?: MetricLabelsOpts<C>;
  buckets?: {
    processing?: number[];
    total?: number[];
    relay?: number[];
  };
}

export class MetricLabelsOpts<C extends StorageContext> {
  labelNames: string[];
  customizer: (context: C) => Promise<MetricRecord>;

  constructor(
    labelNames: string[] = [],
    customizer: (ctx: C) => Promise<MetricRecord>,
  ) {
    this.labelNames = labelNames;
    this.customizer = customizer;
  }
}

const getLabels = async <C extends StorageContext>(
  ctx: C,
  opts: MetricsOpts<C>,
  failed: boolean,
) => {
  const defaultLabels = { status: failed ? "failed" : "succeeded" };

  try {
    const labels: MetricRecord = await (opts.labels?.customizer(ctx) ??
      Promise.resolve({}));

    const allowedKeys = opts.labels?.labelNames ?? [];
    const validatedLabels: MetricRecord = {};
    allowedKeys.forEach(key => {
      if (labels[key]) {
        validatedLabels[key] = labels[key];
      }
    });

    return { ...defaultLabels, ...validatedLabels };
  } catch (error) {
    ctx.logger?.error(
      "Failed to customize metric labels, please review",
      error,
    );

    return defaultLabels;
  }
};

export function metrics<C extends StorageContext>(
  opts: MetricsOpts<C> = {},
): Middleware<C> {
  opts.registry = opts.registry || register;

  const processedVaasTotal = new Counter({
    name: "vaas_processed_total",
    help: "Number of incoming vaas processed successfully or unsuccessfully.",
    labelNames: opts.labels?.labelNames ?? [],
    registers: [opts.registry],
  });

  const finishedVaasTotal = new Counter({
    name: "vaas_finished_total",
    help: "Number of vaas processed successfully or unsuccessfully.",
    labelNames: [status, terminal].concat(opts.labels?.labelNames ?? []),
    registers: [opts.registry],
  });

  const processingDuration = new Histogram({
    name: "vaas_processing_duration",
    help: "Processing time in ms for jobs",
    buckets: opts.buckets?.processing ?? defaultTimeBuckets,
    labelNames: [status].concat(opts.labels?.labelNames ?? []),
    registers: [opts.registry],
  });

  const totalDuration = new Histogram({
    name: "vaas_total_duration",
    help: "Processing time in ms since VAA was published",
    buckets: opts.buckets?.total ?? defaultTimeBuckets,
    labelNames: [status].concat(opts.labels?.labelNames ?? []),
    registers: [opts.registry],
  });

  const relayDuration = new Histogram({
    name: "vaas_relay_duration",
    help: "Time between relayer gets notified of VAA and processing end",
    buckets: opts.buckets?.relay ?? defaultTimeBuckets,
    labelNames: [status].concat(opts.labels?.labelNames ?? []),
    registers: [opts.registry],
  });

  const metricsMiddleware = async (ctx: C, next: Next) => {
    processedVaasTotal.inc();
    let failure: unknown;

    const startTime = Date.now();

    try {
      await next();
    } catch (e) {
      if (e === undefined) {
        failure = new Error(
          "Got thrown undefined while calling next metrics middleware.",
        );
      } else {
        failure = e;
      }
    }

    const job = new MeasuredRelayJob(startTime, Date.now(), ctx.storage.job);
    const labels = await getLabels(ctx, opts, failure !== undefined);

    processingDuration.labels(labels).observe(job.processingTime());

    if (job.totalTime() > 0) {
      totalDuration.labels(labels).observe(job.totalTime());
    }

    if (job.relayingTime() > 0) {
      relayDuration.labels(labels).observe(job.relayingTime());
    }

    if (failure !== undefined) {
      finishedVaasTotal
        .labels({ ...labels, terminal: `${job.hasReachedMaxAttempts()}` })
        .inc();

      throw failure;
    }

    finishedVaasTotal.labels(labels).inc();
  };

  return metricsMiddleware;
}
