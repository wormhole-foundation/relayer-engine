"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metrics = void 0;
const prom_client_1 = require("prom-client");
const processedVaasTotal = new prom_client_1.Counter({
    name: "vaas_processed_total",
    help: "Number of vaas processed successfully or unsuccessfully.",
});
const finishedVaasTotal = new prom_client_1.Counter({
    name: "vaas_processed_total",
    help: "Number of vaas processed successfully or unsuccessfully.",
    labelNames: ["status"],
});
function metrics() {
    return async (ctx, next) => {
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
        }
        catch (e) {
            finishedVaasTotal.labels({ status: "failed" }).inc();
        }
    };
}
exports.metrics = metrics;
//# sourceMappingURL=metrics.middleware.js.map