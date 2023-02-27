import * as relayerEngine from "relayer-engine";
import {
  DummyPlugin,
  DummyPluginConfig,
} from "../plugins/dummy_plugin/src/plugin";

async function main() {
  // load plugin config
  const pluginConfig = (await relayerEngine.loadFileAndParseToObject(
    `./plugins/dummy_plugin/config/${relayerEngine.EnvType.DEVNET.toLowerCase()}.json`,
  )) as DummyPluginConfig;

  const mode =
    (process.env.RELAYER_ENGINE_MODE?.toUpperCase() as relayerEngine.Mode) ||
    relayerEngine.Mode.BOTH;

  // run relayer engine
  await relayerEngine.run({
    configs: "./relayer-engine-config",
    plugins: {
      [DummyPlugin.pluginName]: (engineConfig, logger) =>
        new DummyPlugin(engineConfig, pluginConfig, logger),
    },

    mode,
  });
}

// allow main to be an async function and block until it rejects or resolves
main().catch(e => {
  console.error(e);
  console.error(e.stackTrace);
  process.exit(1);
});
