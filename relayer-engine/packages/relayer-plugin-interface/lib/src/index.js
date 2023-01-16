"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = exports.initLogger = exports.dbg = exports.getScopedLogger = exports.getLogger = void 0;
const Koa = require("koa");
const prom_client_1 = require("prom-client");
const Router = require("koa-router");
const dotenv = require("dotenv");
const config_1 = require("./config");
const logHelper_1 = require("./helpers/logHelper");
const storage_1 = require("./storage");
__exportStar(require("./config"), exports);
__exportStar(require("./utils/utils"), exports);
__exportStar(require("./storage"), exports);
const listenerHarness = require("./listener/listenerHarness");
const executorHarness = require("./executor/executorHarness");
const providers_1 = require("./utils/providers");
const prom_client_2 = require("prom-client");
const metrics_1 = require("./metrics");
const eventHarness_1 = require("./listener/eventHarness");
var logHelper_2 = require("./helpers/logHelper");
Object.defineProperty(exports, "getLogger", { enumerable: true, get: function () { return logHelper_2.getLogger; } });
Object.defineProperty(exports, "getScopedLogger", { enumerable: true, get: function () { return logHelper_2.getScopedLogger; } });
Object.defineProperty(exports, "dbg", { enumerable: true, get: function () { return logHelper_2.dbg; } });
Object.defineProperty(exports, "initLogger", { enumerable: true, get: function () { return logHelper_2.initLogger; } });
__exportStar(require("relayer-plugin-interface"), exports);
dotenv.config();
async function run(args) {
    await readAndValidateEnv(args);
    const commonEnv = (0, config_1.getCommonEnv)();
    const logger = (0, logHelper_1.getLogger)(commonEnv);
    const plugins = args.plugins.map(({ fn, pluginName }) => fn(commonEnv, (0, logHelper_1.getScopedLogger)([pluginName])));
    const storage = await (0, storage_1.createStorage)(plugins, commonEnv, args.store);
    // run each plugins afterSetup lifecycle hook to gain access to
    // providers for each chain and the eventSource hook that allows
    // plugins to create their own events that the listener will respond to
    const providers = (0, providers_1.providersFromChainConfig)(commonEnv.supportedChains);
    await Promise.all(plugins.map(p => p.afterSetup &&
        p.afterSetup(providers, commonEnv.mode === config_1.Mode.LISTENER || commonEnv.mode === config_1.Mode.BOTH
            ? {
                eventSource: (event, extraData) => (0, eventHarness_1.consumeEventHarness)(event, p, storage, providers, extraData),
                db: storage.getStagingAreaKeyLock(p.pluginName),
            }
            : undefined)));
    metrics_1.pluginsConfiguredGauge.set(plugins.length);
    new prom_client_2.Gauge({
        name: "enqueued_workflows",
        help: "Count of workflows waiting to be executed.",
        async collect() {
            // Invoked when the registry collects its metrics' values.
            const currentValue = await storage.numEnqueuedWorkflows();
            this.set(currentValue);
        },
    });
    new prom_client_2.Gauge({
        name: "delayed_workflows",
        help: "Count of workflows waiting to be requeued after erroring out.",
        async collect() {
            // Invoked when the registry collects its metrics' values.
            const currentValue = await storage.numDelayedWorkflows();
            this.set(currentValue);
        },
    });
    switch (commonEnv.mode) {
        case config_1.Mode.LISTENER:
            logger.info("Running in listener mode");
            await listenerHarness.run(plugins, storage);
            break;
        case config_1.Mode.EXECUTOR:
            logger.info("Running in executor mode");
            await executorHarness.run(plugins, storage);
            break;
        case config_1.Mode.BOTH:
            logger.info("Running as both executor and listener");
            await Promise.all([
                executorHarness.run(plugins, storage),
                listenerHarness.run(plugins, storage),
            ]);
            break;
        default:
            throw new Error("Expected MODE env var to be listener or executor, instead got: " +
                process.env.MODE);
    }
    // Will need refactor when we implement rest listeners and readiness probes
    if (commonEnv.promPort) {
        const app = new Koa();
        const router = new Router();
        router.get("/metrics", async (ctx, next) => {
            let metrics = await prom_client_1.register.metrics();
            ctx.body = metrics;
        });
        app.use(router.allowedMethods());
        app.use(router.routes());
        // try {
        app.listen(commonEnv.promPort, () => logger.info(`Prometheus metrics running on port ${commonEnv.promPort}`));
        // } catch (e: any) {
        //   console.log(e.toString());
        //   if (e.toString().includes("EADDRINUSE")) {
        //     for (let i = 0; i < 100; ++i) {
        //       try {
        //         app.listen(commonEnv.promPort + i, () =>
        //           logger.info(
        //             `Prometheus metrics running on port ${commonEnv.promPort! + i}`,
        //           ),
        //         );
        //         break;
        //       } catch {}
        //     }
        //   }
        // }
    }
}
exports.run = run;
async function readAndValidateEnv({ configs, mode, }) {
    if (typeof configs === "string") {
        await (0, config_1.loadUntypedEnvs)(configs, mode, { privateKeyEnv: true }).then(config_1.validateEnvs);
        return;
    }
    (0, config_1.validateEnvs)({
        mode,
        rawCommonEnv: configs.commonEnv,
        rawListenerEnv: configs.listenerEnv,
        rawExecutorEnv: configs.executorEnv,
    });
}
//# sourceMappingURL=index.js.map