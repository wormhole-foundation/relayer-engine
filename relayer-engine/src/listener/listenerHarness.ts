import { getCommonEnv, getListenerEnv } from "../config";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { Plugin } from "relayer-plugin-interface";
import { createSpyRPCServiceClient } from "@certusone/wormhole-spydk";
import { Storage } from "../storage";
import { providersFromChainConfig } from "../utils/providers";
import { runPluginSpyListener } from "./spyEventSource";
import { PluginEventSource } from "./pluginEventSource";

// TODO: get from config or sdk etc.
const NUM_GUARDIANS = 19;

let _logger: ScopedLogger;
const logger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["listenerHarness"]);
  }
  return _logger;
};

export async function run(plugins: Plugin[], storage: Storage) {
  const listnerEnv = getListenerEnv();
  const commonEnv = getCommonEnv();
  const providers = providersFromChainConfig(commonEnv.supportedChains);

  //if spy is enabled, instantiate spy with filters
  if (shouldSpy(plugins)) {
    logger().info(
      `Initializing spy listener on ${listnerEnv.spyServiceHost}...`,
    );
    const spyClient = createSpyRPCServiceClient(
      listnerEnv.spyServiceHost || "",
    );
    plugins.forEach(plugin => {
      if (plugin.shouldSpy) {
        logger().info(
          `Initializing spy listener for plugin ${plugin.pluginName}...`,
        );
        runPluginSpyListener(
          plugin,
          storage,
          spyClient,
          providers,
          commonEnv.numGuardians || NUM_GUARDIANS,
        );
      }
    });
  }

  //if rest is enabled, instantiate rest with filters
  if (shouldRest(plugins)) {
    //const restListener = setupRestListener(restFilters);
  }
  logger().debug("End of listener harness run function");
}

function shouldRest(plugins: Plugin[]): boolean {
  return plugins.some(x => x.shouldRest);
}

function shouldSpy(plugins: Plugin[]): boolean {
  return plugins.some(x => x.shouldSpy);
}
