import * as relayerEngine from "relayer-engine";
import { EnvType } from "relayer-plugin-interface";
import { DummyPlugin, DummyPluginConfig } from "./plugin";

async function main() {
  // load relayer engine configs
  const relayerConfigs = await relayerEngine.loadRelayerEngineConfig(
    "./relayer-engine-config",
    relayerEngine.Mode.BOTH,
    { privateKeyEnv: false }
  );
  const { commonEnv } = relayerConfigs;

  // init the logger used by the relayer engine so we can pass it to the plugin
  relayerEngine.initLogger(commonEnv.logLevel, commonEnv.logDir);

  // initialize the plugin
  const pluginConfig = (await relayerEngine.loadFileAndParseToObject(
    `./config/${relayerEngine.EnvType.DEVNET}.json`.toLowerCase()
  )) as DummyPluginConfig;
  const dummy = new DummyPlugin(
    commonEnv,
    pluginConfig,
    relayerEngine.getScopedLogger([DummyPlugin.pluginName])
  );

  // run relayer engine
  await relayerEngine.run({
    configs: relayerConfigs,
    plugins: [dummy],
    mode: relayerEngine.Mode.BOTH,
  });
}

// allow main to be an async function and block until it rejects or resolves
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
