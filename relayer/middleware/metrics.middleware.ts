import { register } from "prom-client";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { StorageContext } from "../storage/storage";
import { Job } from "bullmq";
import { Counter, Registry } from "prom-client";

interface MetricsOpts {
  registry?: Registry;
}

export function metrics(
  opts: MetricsOpts = {},
): Middleware<Context & { job?: Job }> {
  opts.registry = opts.registry || register;
  const processedVaasTotal = new Counter({
    name: "vaas_processed_total",
    help: "Number of vaas processed successfully or unsuccessfully.",
    registers: [opts.registry],
  });

  const finishedVaasTotal = new Counter({
    name: "vaas_finished_total",
    help: "Number of vaas processed successfully or unsuccessfully.",
    labelNames: ["status"],
    registers: [opts.registry],
  });

  return async (ctx: StorageContext, next) => {
    const job = ctx.storage?.job;
    // disable this metric if storage is enabled because the storage will actually compute the metrics.
    if (job) {
      await next();
      return;
    }

    processedVaasTotal.inc();
    try {
      await next();
      finishedVaasTotal.labels({ status: "succeeded" }).inc();
    } catch (e) {
      finishedVaasTotal.labels({ status: "failed" }).inc();
    }
  };
}
