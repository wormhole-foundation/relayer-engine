import {
  run,
  Mode,
  CommonEnv,
  ExecutorEnv,
  ListenerEnv,
  getLogger,
  initLogger,
} from "relayer-engine";
import { EnvType } from "plugin_interface";
import { DummyPlugin, DummyPluginConfig } from "./index";
import { Keypair } from "@solana/web3.js";

const commonEnv: CommonEnv = {
  envType: EnvType.LOCALHOST,
  mode: Mode.BOTH,
  logLevel: "debug",
  promPort: 8083,
  readinessPort: 2000,
  redisHost: "localhost",
  redisPort: 6379,
  pluginURIs: ["dummy_plugin"],
  supportedChains: [
    {
      chainId: 1,
      chainName: "Solana",
      nodeUrl: "http://localhost:8545",
      nativeCurrencySymbol: "SOL",
      tokenBridgeAddress: "B6RHG3mfcckmrYN1UhmJzyS1XX3fZKbkeUcpJe9Sy3FE",
      bridgeAddress: "Bridge1p5gheXUvJ6jGWGeCsgPKgnE3YgdGKRVCMY9o",
      wrappedAsset: "So11111111111111111111111111111111111111112",
    },
    {
      nativeCurrencySymbol: "ETH",
      chainId: 2,
      chainName: "Ethereum",
      nodeUrl: "http://localhost:8899",
      tokenBridgeAddress: "0x0290FB167208Af455bB137780163b7B7a9a10C16",
      wrappedAsset: "0xDDb64fE46a91D46ee29420539FC25FD07c5FEa3E",
    },
  ],
};

const executorEnv: ExecutorEnv = {
  // @ts-ignore
  privateKeys: {
    1: [
      `[
        14, 173, 153, 4, 176, 224, 201, 111, 32, 237, 183, 185, 159, 247, 22,
        161, 89, 84, 215, 209, 212, 137, 10, 92, 157, 49, 29, 192, 101, 164,
        152, 70, 87, 65, 8, 174, 214, 157, 175, 126, 98, 90, 54, 24, 100, 177,
        247, 77, 19, 112, 47, 44, 165, 109, 233, 102, 14, 86, 109, 29, 134, 145,
        132, 141
      ]`,
    ],
    2: ["0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"],
  },
};

const listenerEnv: ListenerEnv = {
  spyServiceHost: "localhost:7073",
  numSpyWorkers: 1,
};

async function main() {
  initLogger(commonEnv.logDir, commonEnv.logLevel);
  const dummyConfig: DummyPluginConfig = {
    shouldRest: false,
    shouldSpy: true,
    demoteInProgress: true,
    spyServiceFilters: [
      {
        chainId: 1,
        emitterAddress: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      },
      {
        chainId: 6,
        emitterAddress: "0x61E44E506Ca5659E6c0bba9b678586fA2d729756",
      },
    ],
  };
  const dummy = new DummyPlugin(commonEnv, dummyConfig, getLogger());
  run({
    // configs: "../../relayer/config",
    configs: {
      commonEnv,
      executorEnv,
      listenerEnv,
    },
    plugins: [dummy],
    mode: Mode.BOTH,
    envType: EnvType.LOCALHOST,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
