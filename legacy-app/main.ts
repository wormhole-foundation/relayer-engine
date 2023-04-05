import { DummyPlugin } from "./plugins/dummy_plugin/src/plugin";
import yargs from "yargs";
import * as Koa from "koa";
import {
  Environment,
  LegacyPluginCompat,
  LoggingContext,
  RelayerApp,
  SourceTxContext,
  StagingAreaContext,
  StandardRelayerApp,
  StorageContext,
  TokenBridgeContext,
  WalletContext,
} from "wormhole-relayer";
import { Logger } from "winston";
import { defaultLogger as logger } from "wormhole-relayer/logging";
import * as fs from "fs";
import { CHAIN_ID_AVAX, CHAIN_ID_SOLANA } from "@certusone/wormhole-sdk";

export type MyRelayerContext = LoggingContext &
  StorageContext &
  SourceTxContext &
  TokenBridgeContext &
  StagingAreaContext &
  WalletContext;

async function main() {
  let opts: any = yargs(process.argv.slice(2)).argv;

  const env = Environment.TESTNET;
  const app = new StandardRelayerApp(env, {
    name: "example-legacy-app",
    privateKeys: {
      [CHAIN_ID_AVAX]: [
        "0xddadef4776be04a195530bb6e9e82013cee5ca442b53db4d6668246d9e6834a8",
      ],
    },
    logger,
  });
  const pluginConfig = JSON.parse(
    String(fs.readFileSync("./plugins/dummy_plugin/config/testnet.json"))
  );

  const plugin = new DummyPlugin({} as any, pluginConfig, logger);
  LegacyPluginCompat.legacyPluginCompat(app, plugin);

  app.use(async (err, ctx, next) => {
    ctx.logger.error("error middleware triggered");
  }); // <-- if you pass in a function with 3 args, it'll be used to process errors (whenever you throw from your middleware)

  app.listen();
  runUI(app, opts, logger);
}

function runUI(relayer: RelayerApp<any>, { port }: any, logger: Logger) {
  const app = new Koa();

  app.use(relayer.storageKoaUI("/ui"));
  app.use(async (ctx, next) => {
    if (ctx.request.method !== "GET" && ctx.request.url !== "/metrics") {
      await next();
      return;
    }

    ctx.body = await relayer.metricsRegistry().metrics();
  });

  port = Number(port) || 3000;
  app.listen(port, () => {
    logger.info(`Running on ${port}...`);
    logger.info(`For the UI, open http://localhost:${port}/ui`);
    logger.info("Make sure Redis is running on port 6379 by default");
  });
}

// allow main to be an async function and block until it rejects or resolves
main().catch((e) => {
  console.error(e);
  console.error(e.stackTrace);
  process.exit(1);
});
