import { Histogram, register } from "prom-client";
import { Middleware } from "../compose.middleware";
import { RelayJob, StorageContext } from "../storage/storage";
import { Counter, Registry } from "prom-client";

type MetricRecord = Record<string, string | number>;

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
    return (this.job?.attempts ?? 0) === (this.job?.maxAttempts ?? -1);
  }

  vaaTimestamp(): number {
    // vaa.timestamp is in seconds
    return this.job?.data?.parsedVaa?.timestamp * 1000 ?? -1;
  }

  processingTime(): number {
    return this.endTime - this.startTime;
  }

  totalTime(): number {
    if (this.vaaTimestamp() > 0) {
      return this.endTime - this.vaaTimestamp();
    }

    return -1;
  }
}

const status = "status";
const terminal = "terminal";

export interface MetricsOpts<C extends StorageContext> {
  registry?: Registry;
  labels?: MetricLabelsOpts<C>;
  processingTimeBuckets?: number[];
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
    labelNames: [].concat(opts.labels?.labelNames ?? []),
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
    buckets: opts.processingTimeBuckets ?? [
      6000, 7000, 7500, 8000, 8500, 9000, 10000, 12000,
    ],
    labelNames: [status].concat(opts.labels?.labelNames ?? []),
    registers: [opts.registry],
  });

  const totalDuration = new Histogram({
    name: "vaas_total_duration",
    help: "Processing time in ms for relaying",
    buckets: opts.processingTimeBuckets ?? [
      6000, 7000, 7500, 8000, 8500, 9000, 10000, 12000,
    ],
    labelNames: [status].concat(opts.labels?.labelNames ?? []),
    registers: [opts.registry],
  });

  return async (ctx: C, next) => {
    processedVaasTotal.inc();
    let failure: Error = null;

    const startTime = Date.now();

    try {
      await next();
    } catch (e) {
      failure = e;
    }

    const job = new MeasuredRelayJob(startTime, Date.now(), ctx.storage.job);
    const labels = await getLabels(ctx, opts, failure !== null);

    processingDuration.labels(labels).observe(job.processingTime());

    if (job.totalTime() > 0) {
      totalDuration.labels(labels).observe(job.totalTime());
    }

    if (failure) {
      finishedVaasTotal
        .labels({ ...labels, terminal: `${job.hasReachedMaxAttempts()}` })
        .inc();

      throw failure;
    }

    finishedVaasTotal.labels(labels).inc();
  };
}
