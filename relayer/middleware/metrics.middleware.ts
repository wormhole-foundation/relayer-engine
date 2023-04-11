import { Logger } from "winston";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { StorageContext } from "../storage";
import { Job } from "bullmq";
import { Counter } from "prom-client";

const processedVaasTotal = new Counter({
  name: "vaas_processed_total",
  help: "Number of vaas processed successfully or unsuccessfully.",
});

const finishedVaasTotal = new Counter({
  name: "vaas_finished_total",
  help: "Number of vaas processed successfully or unsuccessfully.",
  labelNames: ["status"],
});

export function metrics(): Middleware<Context & { job?: Job }> {
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
