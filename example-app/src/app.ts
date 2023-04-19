import yargs from "yargs";
import * as Koa from "koa";
import {
  Context,
  Environment,
  logging,
  LoggingContext,
  missedVaas,
  providers,
  RelayerApp,
  sourceTx,
  SourceTxContext,
  stagingArea,
  StagingAreaContext,
  StorageContext,
  TokenBridgeContext,
  tokenBridgeContracts,
  WalletContext,
} from "@wormhole-foundation/relayer-engine";
import { CHAIN_ID_SOLANA } from "@certusone/wormhole-sdk";
import { rootLogger } from "./log";
import { ApiController } from "./controller";
import { Logger } from "winston";
import { RedisStorage } from "../../relayer/storage/redis-storage";

export type MyRelayerContext = LoggingContext &
  StorageContext &
  SourceTxContext &
  TokenBridgeContext &
  StagingAreaContext &
  WalletContext;

// You need to read in your keys
// const privateKeys = {
//   [CHAIN_ID_ETH]: [process.env.ETH_KEY],
// };

async function main() {
  let opts: any = yargs(process.argv.slice(2)).argv;

  const env = Environment.TESTNET;
  const app = new RelayerApp<MyRelayerContext>(env);
  const fundsCtrl = new ApiController();

  // Config
  const store = new RedisStorage({
    attempts: 3,
    namespace: "simple",
    queueName: "relays",
  });
  configRelayer(app, store);

  // Set up middleware
  app.use(logging(rootLogger)); // <-- logging middleware
  app.use(missedVaas(app, { namespace: "simple", logger: rootLogger }));
  app.use(providers());
  // app.use(wallets({ logger: rootLogger, namespace: "simple", privateKeys })); // <-- you need a valid private key to turn on this middleware
  app.use(tokenBridgeContracts());
  app.use(stagingArea());
  app.use(sourceTx());

  app
    .chain(CHAIN_ID_SOLANA)
    .address(
      "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      fundsCtrl.processFundsTransfer
    );

  // Another way to do it if you want to listen to multiple addresses on different chaints:
  // app.multiple(
  //   { [CHAIN_ID_SOLANA]: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe"
  //     [CHAIN_ID_ETH]: ["0xabc1230000000...","0xdef456000....."]
  //   },
  //   fundsCtrl.processFundsTransfer
  // );

  app.use(async (err, ctx, next) => {
    ctx.logger.error("error middleware triggered");
  }); // <-- if you pass in a function with 3 args, it'll be used to process errors (whenever you throw from your middleware)

  app.listen();
  runUI(app, store, opts, rootLogger);
}

function configRelayer<T extends Context>(
  app: RelayerApp<T>,
  store: RedisStorage
) {
  app.spy("localhost:7073");
  app.useStorage(store);
  app.logger(rootLogger);
}

function runUI(
  relayer: RelayerApp<any>,
  store: RedisStorage,
  { port }: any,
  logger: Logger
) {
  const app = new Koa();

  app.use(store.storageKoaUI("/ui"));
  app.use(async (ctx, next) => {
    if (ctx.request.method !== "GET" && ctx.request.url !== "/metrics") {
      await next();
      return;
    }

    ctx.body = await store.registry.metrics();
  });

  port = Number(port) || 3000;
  app.listen(port, () => {
    logger.info(`Running on ${port}...`);
    logger.info(`For the UI, open http://localhost:${port}/ui`);
    logger.info("Make sure Redis is running on port 6379 by default");
  });
}

main();
