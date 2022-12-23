import * as dotenv from "dotenv";
import { EngineInitFn, Plugin } from "relayer-plugin-interface";
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
import { createStorage, InMemory, IRedis, RedisWrapper } from "./storage";
export * from "./config";
export * from "./utils/utils";
export * from "./storage";
import * as listenerHarness from "./listener/listenerHarness";
import * as executorHarness from "./executor/executorHarness";
import { PluginEventSource } from "./listener/pluginEventSource";
import { providersFromChainConfig } from "./utils/providers";
export {
  getLogger,
  getScopedLogger,
  dbg,
  initLogger,
} from "./helpers/logHelper";
export * from "relayer-plugin-interface";

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
  plugins: { fn: EngineInitFn<Plugin>; pluginName: string }[];
  store?: RedisWrapper;
}

export async function run(args: RunArgs): Promise<void> {
  await readAndValidateEnv(args);
  const commonEnv = getCommonEnv();
  const logger = getLogger(commonEnv);
  const plugins = args.plugins.map(({ fn, pluginName }) =>
    fn(commonEnv, getScopedLogger([pluginName])),
  );
  const storage = await createStorage(
    args.store ? args.store : new InMemory(),
    plugins,
  );

  // run each plugins afterSetup lifecycle hook to gain access to
  // providers for each chain and the eventSource hook that allows
  // plugins to create their own events that the listener will respond to
  const pluginEventSource = new PluginEventSource();
  plugins.forEach(
    p =>
      p.afterSetup &&
      p.afterSetup(
        providersFromChainConfig(commonEnv.supportedChains),
        commonEnv.mode === Mode.LISTENER || commonEnv.mode === Mode.BOTH
          ? pluginEventSource.getEventSourceFn(p.pluginName)
          : undefined,
      ),
  );

  switch (commonEnv.mode) {
    case Mode.LISTENER:
      logger.info("Running in listener mode");
      await listenerHarness.run(plugins, storage, pluginEventSource);
      return;
    case Mode.EXECUTOR:
      logger.info("Running in executor mode");
      await executorHarness.run(plugins, storage);
      return;
    case Mode.BOTH:
      logger.info("Running as both executor and listener");
      await Promise.all([
        executorHarness.run(plugins, storage),
        listenerHarness.run(plugins, storage, pluginEventSource),
      ]);
      return;
    default:
      throw new Error(
        "Expected MODE env var to be listener or executor, instead got: " +
          process.env.MODE,
      );
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
    await loadUntypedEnvs(configs, mode).then(validateEnvs);
    return;
  }
  validateEnvs({
    mode,
    rawCommonEnv: configs.commonEnv,
    rawListenerEnv: configs.listenerEnv,
    rawExecutorEnv: configs.executorEnv,
  });
}
