import * as relayerEngine from "relayer-engine";
import DummyPluginFactory, {
  DummyPluginConfig,
} from "../plugins/dummy_plugin/src/plugin";

async function main() {
  // load plugin config
  const pluginConfig = (await relayerEngine.loadFileAndParseToObject(
    `./plugins/dummy_plugin/config/${relayerEngine.EnvType.DEVNET.toLowerCase()}.json`
  )) as DummyPluginConfig;

  // run relayer engine
  await relayerEngine.run({
    configs: "./relayer-engine-config",
    plugins: [new DummyPluginFactory(pluginConfig)],
    mode: relayerEngine.Mode.BOTH,
  });
}

// allow main to be an async function and block until it rejects or resolves
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
