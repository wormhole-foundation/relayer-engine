import yargs from "yargs";
import * as Koa from "koa";
import { RelayerApp, StorageContext } from "wormhole-relayer";
import { CHAIN_ID_SOLANA } from "@certusone/wormhole-sdk";
import {
  logging,
  LoggingContext,
} from "wormhole-relayer/lib/middleware/logger.middleware";
import { rootLogger } from "./log";
import { ApiController } from "./controller";

export type MyRelayerContext = LoggingContext & StorageContext;

async function main() {
  let opts: any = yargs(process.argv.slice(2)).argv;
  const relayer = new RelayerApp<MyRelayerContext>();

  relayer.spy("localhost:7073");
  relayer.useStorage({ attempts: 3, namespace: "simple", queueName: "relays" });
  relayer.logger(rootLogger);

  relayer.use(logging(rootLogger)); // <-- logging middleware

  const fundsCtrl = new ApiController();

  relayer
    .chain(CHAIN_ID_SOLANA)
    .address(
      "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      fundsCtrl.processFundsTransfer
    );

  relayer.listen();

  runUI(relayer, opts);
}

function runUI(relayer: any, opts: any) {
  const app = new Koa();

  app.use(relayer.storageKoaUI("/ui"));

  app.listen(opts.port ?? 3000, () => {
    console.log(`Running on ${opts.port}...`);
    console.log("For the UI, open http://localhost:3000/ui");
    console.log("Make sure Redis is running on port 6379 by default");
  });
}

main();
