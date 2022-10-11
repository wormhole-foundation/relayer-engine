import { setDefaultWasm } from "@certusone/wormhole-sdk/lib/cjs/solana/wasm";
import {
  CommonEnv,
  getCommonEnv,
  getExecutorEnv,
  getListenerEnv,
  getLogger,
  initLogger,
  Mode,
  run,
  validateEnvs,
} from "relayer-engine";
import { loadPlugins } from "./loadPlugins";
import { loadUntypedEnvsDefault } from "./config";

setDefaultWasm("node");

async function main() {
  await loadUntypedEnvsDefault().then(validateEnvs);
  const commonEnv = getCommonEnv();
  initLogger(commonEnv.logDir, commonEnv.logLevel);
  const logger = getLogger();
  const plugins = await loadPlugins(commonEnv);

  logger.info("Starting relayer engine...");
  run({
    configs: {
      commonEnv,
      executorEnv:
        commonEnv.mode !== Mode.LISTENER ? getExecutorEnv() : undefined,
      listenerEnv:
        commonEnv.mode !== Mode.EXECUTOR ? getListenerEnv() : undefined,
    },
    mode: commonEnv.mode,
    envType: commonEnv.envType,
    plugins,
  });
  launchReadinessPortTask(commonEnv);
}

async function launchReadinessPortTask(commonEnv: CommonEnv) {
  if (!commonEnv.readinessPort) {
    getLogger().warn(
      "Readiness port not defined, not starting readiness server"
    );
    return;
  }
  const Net = await import("net");
  const readinessServer = new Net.Server();
  readinessServer.listen(commonEnv.readinessPort, function () {
    getLogger().info(
      "listening for readiness requests on port " + commonEnv.readinessPort
    );
  });

  readinessServer.on("connection", function (socket: any) {
    //logger.debug("readiness connection");
  });
}

main().catch((e) => {
  console.error("Fatal Error");
  console.error(e);
  process.exit(1);
});
