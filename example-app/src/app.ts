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
  wallets,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_SOLANA,
  CHAIN_ID_ETH,
  CHAIN_ID_SUI,
} from "@certusone/wormhole-sdk";
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

// npx ganache -i 5777 \
//     --wallet.accounts=0xf9fdbcbcdb4c7c72642be9fe7c09ad5869a961a8ae3c3374841cb6ead5fd34b1,1000000000000000000 \
//     --wallet.accounts=0x5da88a1c7df3490d040792fcca4676e709fdd3e6f6e0142accc96cb7e205e1e0,1000000000000000000 \
//     --wallet.accounts=0xa2c984f6a752ee05af03dac0bb65f3ec93f1498d43d23ebe6c31cf988d771423,1000000000000000000 \
//     --wallet.accounts=0xe0c1c809d0e80dcaaf200b3aec2a91cd00ed05134f10026113219d89d2f6a9b2,1000000000000000000 \
//     --wallet.accounts=0x3500084e268b862df23a229f268510cdee92623102c4786b0ade6203fa59f421,1000000000000000000 \
//     --wallet.accounts=0x49692cfecfb48cee7ce8a14273bda6996b832149ff7260bca09c2ea159e9147f,1000000000000000000 \
//     --wallet.accounts=0xb2868bd9090dcfbc9d6f3012c98039ee20d778f8ef2d8cb721c56b69578934f3,1000000000000000000 \
//     --wallet.accounts=0x50156cc51cb7ae4f5e6e2cb14a75fc177a1917fbab1a8675db25619567515ddd,1000000000000000000 \
//     --wallet.accounts=0x6790f27fec85575792c7d1fab8de9955aff171b24329eacf2a279defa596c5d3,1000000000000000000 \
//     --wallet.accounts=0xe94000d730b9655850afc8e39facb7058678f11e765075d4806d27ed619f258c,1000000000000000000

const privateKeys = {
  [CHAIN_ID_ETH]: [
    "0xf9fdbcbcdb4c7c72642be9fe7c09ad5869a961a8ae3c3374841cb6ead5fd34b1",
    "0x5da88a1c7df3490d040792fcca4676e709fdd3e6f6e0142accc96cb7e205e1e0",
    "0xa2c984f6a752ee05af03dac0bb65f3ec93f1498d43d23ebe6c31cf988d771423",
    "0xe0c1c809d0e80dcaaf200b3aec2a91cd00ed05134f10026113219d89d2f6a9b2",
    "0x3500084e268b862df23a229f268510cdee92623102c4786b0ade6203fa59f421",
    "0x49692cfecfb48cee7ce8a14273bda6996b832149ff7260bca09c2ea159e9147f",
    "0xb2868bd9090dcfbc9d6f3012c98039ee20d778f8ef2d8cb721c56b69578934f3",
    "0x50156cc51cb7ae4f5e6e2cb14a75fc177a1917fbab1a8675db25619567515ddd",
    "0x6790f27fec85575792c7d1fab8de9955aff171b24329eacf2a279defa596c5d3",
    "0xe94000d730b9655850afc8e39facb7058678f11e765075d4806d27ed619f258c",
  ],
  [CHAIN_ID_SUI]: ["ODV9VYi3eSljEWWmpWh8s9m/P2BNNxU/Vp8jwADeNew="],
};

async function main() {
  let opts: any = yargs(process.argv.slice(2)).argv;

  const app = new RelayerApp<MyRelayerContext>(Environment.TESTNET);

  const fundsCtrl = new ApiController();
  const namespace = "simple-relayer-example";
  // Config
  const store = new RedisStorage({
    attempts: 3,
    namespace,
    queueName: "relays",
  });
  configRelayer(app, store);

  // Set up middleware
  app.use(logging(rootLogger)); // <-- logging middleware
  app.use(missedVaas(app, { namespace: "simple", logger: rootLogger }));
  app.use(providers());

  app.use(
    wallets(Environment.TESTNET, {
      privateKeys,
      namespace,
      metrics: { enabled: true, registry: store.registry },
    }),
  ); // <-- you need a valid private key to turn on this middleware

  app.use(tokenBridgeContracts());
  app.use(stagingArea());
  app.use(sourceTx());

  app
    .chain(CHAIN_ID_SOLANA)
    .address(
      "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      fundsCtrl.processFundsTransfer,
    );

  // Another way to do it if you want to listen to multiple addresses on different chains:
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
  store: RedisStorage,
) {
  app.spy("localhost:7073");
  app.useStorage(store);
  app.logger(rootLogger);
}

function runUI(
  relayer: RelayerApp<any>,
  store: RedisStorage,
  { port }: any,
  logger: Logger,
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
