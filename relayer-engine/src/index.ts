import * as wh from "@certusone/wormhole-sdk";
import { EnvType, Plugin } from "relayer-plugin-interface";
import {
  CommonEnv,
  ExecutorEnv,
  getCommonEnv,
  ListenerEnv,
  loadUntypedEnvs,
  Mode,
  validateEnvs,
} from "./config";
import { getLogger } from "./helpers/logHelper";
import { createStorage, InMemoryStore, Store } from "./storage";
export * from "./config";
export * from "./utils/utils";
export * from "./storage";
import * as listenerHarness from "./listener/listenerHarness";
import * as executorHarness from "./executor/executorHarness";
export {
  getLogger,
  getScopedLogger,
  dbg,
  initLogger,
} from "./helpers/logHelper";

wh.setDefaultWasm("node");

export interface RunArgs {
  // for configs, provide file path or config objects
  configs:
    | string
    | {
        commonEnv: CommonEnv;
        executorEnv?: ExecutorEnv;
        listenerEnv?: ListenerEnv;
      };
  mode: Mode;
  envType: EnvType;
  plugins: Plugin[];
  store?: Store;
}

export async function run(args: RunArgs): Promise<void> {
  const logger = getLogger();
  const storage = await createStorage(
    args.store ? args.store : new InMemoryStore(),
    args.plugins
  );
  await readAndValidateEnv(args);

  const commonEnv = getCommonEnv();
  switch (commonEnv.mode) {
    case Mode.LISTENER:
      logger.info("Running in listener mode");
      await listenerHarness.run(args.plugins, storage);
      return;
    case Mode.EXECUTOR:
      logger.info("Running in executor mode");
      await executorHarness.run(args.plugins, storage);
      return;
    case Mode.BOTH:
      logger.info("Running as both executor and listener");
      await Promise.all([
        executorHarness.run(args.plugins, storage),
        listenerHarness.run(args.plugins, storage),
      ]);
      return;
    default:
      throw new Error(
        "Expected MODE env var to be listener or executor, instead got: " +
          process.env.MODE
      );
  }
}

async function readAndValidateEnv({
  configs,
  mode,
  envType,
}: {
  configs:
    | string
    | {
        commonEnv: CommonEnv;
        executorEnv?: ExecutorEnv;
        listenerEnv?: ListenerEnv;
      };

  mode: Mode;
  envType: EnvType;
}) {
  if (typeof configs === "string") {
    await loadUntypedEnvs(configs, mode, envType).then(validateEnvs);
    return;
  }
  validateEnvs({
    mode,
    rawCommonEnv: configs.commonEnv,
    rawListenerEnv: configs.listenerEnv,
    rawExecutorEnv: configs.executorEnv,
  });
}
