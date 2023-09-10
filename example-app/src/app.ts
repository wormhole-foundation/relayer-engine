import yargs from "yargs";
import {
  Environment,
  logging,
  LoggingContext,
  providers,
  RelayerApp,
  sourceTx,
  SourceTxContext,
  spawnMissedVaaWorker,
  stagingArea,
  StagingAreaContext,
  StorageContext,
  TokenBridgeContext,
  tokenBridgeContracts,
  WalletContext,
  wallets,
} from "@wormhole-foundation/relayer-engine";
import { RedisStorage } from "@wormhole-foundation/relayer-engine/storage/redis-storage";
import {
  CHAIN_ID_ETH,
  CHAIN_ID_SOLANA,
  CHAIN_ID_SUI,
} from "@certusone/wormhole-sdk";
import { rootLogger } from "./log.js";
import { ApiController } from "./controller.js";
import { runUI } from "./ui.js";
import { configRelayer } from "./config.js";

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

const privateKeys = {
  [CHAIN_ID_ETH]: ["0xYOUR_PRIVATE_KEY_HERE"],
  [CHAIN_ID_SUI]: ["PRIVATE_KEY"],
};

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
spawnMissedVaaWorker(app, { namespace: "simple", logger: rootLogger });
app.use(providers());

// app.use(
//   wallets(Environment.TESTNET, {
//     privateKeys,
//     namespace,
//     metrics: { enabled: true, registry: store.registry },
//   })
// ); // <-- you need a valid private key to turn on this middleware

app.use(tokenBridgeContracts());
app.use(stagingArea());
app.use(sourceTx());

app
  .chain(CHAIN_ID_SOLANA)
  .address(
    "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
    fundsCtrl.processFundsTransfer
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
