import Koa from "koa";
import Router from "koa-router";
import bodyParser from "koa-bodyparser";
import auth from "koa-basic-auth";
import { register } from "prom-client";
import * as dotenv from "dotenv";
import { EngineInitFn, Plugin } from "../packages/relayer-plugin-interface";
import {
  CommonEnv,
  ExecutorEnv,
  getCommonEnv,
  ListenerEnv,
  loadUntypedEnvs,
  Mode,
  validateEnvs,
} from "./config";
import { getLogger, getScopedLogger } from "./helpers/logHelper";
import { createStorage, Storage } from "./storage";
export * from "./config";
export * from "./utils/utils";
export * from "./storage";
import * as listenerHarness from "./listener/listenerHarness";
import * as executorHarness from "./executor/executorHarness";
import { providersFromChainConfig } from "./utils/providers";
import { registerGauges } from "./metrics";
import { SignedVaa } from "@certusone/wormhole-sdk";
import { consumeEventHarness } from "./listener/eventHarness";
import { randomUUID } from "crypto";
import { WorkflowsController } from "./api/controller";
export {
  getLogger,
  getScopedLogger,
  dbg,
  initLogger,
} from "./helpers/logHelper";
export * from "../packages/relayer-plugin-interface";

dotenv.config();

export type CommonEnvRun = Omit<Omit<CommonEnv, "envType">, "mode">;
export interface RunArgs {
  // for configs, provide file path or config objects
  configs:
    | string
    | {
        commonEnv: CommonEnvRun;
        executorEnv?: ExecutorEnv;
        listenerEnv?: ListenerEnv;
      };
  mode: Mode;
  plugins: { [pluginName: string]: EngineInitFn<Plugin> };
}

export async function run(args: RunArgs): Promise<void> {
  await readAndValidateEnv(args);
  const commonEnv = getCommonEnv();
  const logger = getLogger(commonEnv);
  const plugins = Object.entries(args.plugins).map(
    ([pluginName, constructor]) =>
      constructor(commonEnv, getScopedLogger([pluginName])),
  );
  const nodeId = randomUUID();
  const storage = await createStorage(plugins, commonEnv, nodeId);

  registerGauges(storage, plugins.length);
  await invokeAfterSetupHooks(commonEnv, plugins, storage);

  switch (commonEnv.mode) {
    case Mode.LISTENER:
      logger.info("Running in listener mode");
      await listenerHarness.run(plugins, storage);
      break;
    case Mode.EXECUTOR:
      logger.info("Running in executor mode");
      await executorHarness.run(plugins, storage);
      break;
    case Mode.BOTH:
      logger.info("Running as both executor and listener");
      await Promise.all([
        executorHarness.run(plugins, storage),
        listenerHarness.run(plugins, storage),
      ]);
      break;
    default:
      logger.error(`Invalid running mode as argument: ${process.env.MODE}`);
      throw new Error(
        "Expected MODE env var to be listener or executor, instead got: " +
          process.env.MODE,
      );
  }
  // Will need refactor when we implement rest listeners and readiness probes
  if (commonEnv.promPort) {
    launchMetricsServer(commonEnv);
  }
  if (commonEnv.apiPort) {
    launchApiServer(commonEnv, storage);
  }
}

async function readAndValidateEnv({
  configs,
  mode,
}: {
  configs:
    | string
    | {
        commonEnv: CommonEnvRun;
        executorEnv?: ExecutorEnv;
        listenerEnv?: ListenerEnv;
      };

  mode: Mode;
}) {
  if (typeof configs === "string") {
    await loadUntypedEnvs(configs, mode, { privateKeyEnv: true }).then(
      validateEnvs,
    );
    return;
  }
  validateEnvs({
    mode,
    rawCommonEnv: configs.commonEnv,
    rawListenerEnv: configs.listenerEnv,
    rawExecutorEnv: configs.executorEnv,
  });
}

// run each plugins afterSetup lifecycle hook to gain access to
// providers for each chain and the eventSource hook that allows
// plugins to create their own events that the listener will respond to
async function invokeAfterSetupHooks(
  commonEnv: CommonEnv,
  plugins: Plugin[],
  storage: Storage,
) {
  const providers = providersFromChainConfig(commonEnv.supportedChains);
  const promises = plugins.map(
    p =>
      p.afterSetup &&
      p.afterSetup(
        providers,
        commonEnv.mode === Mode.LISTENER || commonEnv.mode === Mode.BOTH
          ? {
              eventSource: (event: SignedVaa, extraData?: any[]) =>
                consumeEventHarness(event, p, storage, providers, extraData),
              db: storage.getStagingAreaKeyLock(p.pluginName),
            }
          : undefined,
      ),
  );
  await Promise.all(promises);
}

async function launchMetricsServer(commonEnv: CommonEnv) {
  const app = new Koa();
  const router = new Router();
  const logger = getScopedLogger(["MetricsServer"]);

  router.get("/metrics", async (ctx, next) => {
    let metrics = await register.metrics();
    ctx.body = metrics;
  });

  app.use(router.allowedMethods());
  app.use(router.routes());
  app.listen(commonEnv.promPort, () =>
    logger.info(`Prometheus metrics running on port ${commonEnv.promPort}`),
  );
}

async function launchApiServer(commonEnv: CommonEnv, storageServ: Storage) {
  const app = new Koa();

  app.use(bodyParser());
  const logger = getScopedLogger(["ApiServer"]);
  const workflowsCtrl = new WorkflowsController(storageServ);

  const workflows = new Router();

  workflows.prefix("/workflows");
  workflows.get("/", workflowsCtrl.getWorkflow);
  workflows.post("/retry", workflowsCtrl.moveFailedWorkflowToReady);
  workflows.get("/:status", workflowsCtrl.getWorkflowsByStatus);

  if (commonEnv.apiKey) {
    app.use(auth({ name: "admin", pass: commonEnv.apiKey }));
  }

  app.use(workflows.allowedMethods());
  app.use(workflows.routes());
  app.listen(commonEnv.apiPort, () =>
    logger.info(`Api running on port ${commonEnv.apiPort}`),
  );
}
