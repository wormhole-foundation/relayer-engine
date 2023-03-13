import yargs from "yargs";
import * as Koa from "koa";
import { RelayerApp, StorageContext, Context } from "wormhole-relayer";
import { CHAIN_ID_SOLANA } from "@certusone/wormhole-sdk";
import {
  logging,
  LoggingContext,
} from "wormhole-relayer/lib/middleware/logger.middleware";
import {
  TokenBridgeContext,
  tokenBridgeContracts,
} from "wormhole-relayer/lib/middleware/tokenBridge.middleware";
import { missedVaas } from "wormhole-relayer/lib/middleware/missedVaas.middleware";
import { providers } from "wormhole-relayer/lib/middleware/providers.middleware";

import { rootLogger } from "./log";
import { ApiController } from "./controller";

export type MyRelayerContext = LoggingContext &
  StorageContext &
  TokenBridgeContext;

async function main() {
  let opts: any = yargs(process.argv.slice(2)).argv;
  const app = new RelayerApp<MyRelayerContext>();
  const fundsCtrl = new ApiController();

  // Config
  app.testnet();
  configRelayer(app);

  // Set up middleware
  app.use(logging(rootLogger)); // <-- logging middleware
  app.use(missedVaas(app, { namespace: "simple", logger: rootLogger }));
  app.use(providers());
  app.use(tokenBridgeContracts());

  app
    .chain(CHAIN_ID_SOLANA)
    .address(
      "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      fundsCtrl.processFundsTransfer
    );

  app.use(async (err, ctx, next) => {
    ctx.logger.error("error middleware triggered");
  }); // <-- if you pass in a function with 3 args, it'll be used to process errors (whenever you throw from your middleware)

  app.listen();

  runUI(app, opts);
}

function configRelayer<T extends Context>(app: RelayerApp<T>) {
  app.spy("localhost:7073");
  app.useStorage({ attempts: 3, namespace: "simple", queueName: "relays" });
  app.logger(rootLogger);
}

function runUI(relayer: any, { port }: any) {
  const app = new Koa();

  app.use(relayer.storageKoaUI("/ui"));

  port = Number(port) || 3000;
  app.listen(port, () => {
    console.log(`Running on ${port}...`);
    console.log(`For the UI, open http://localhost:${port}/ui`);
    console.log("Make sure Redis is running on port 6379 by default");
  });
}

main();
