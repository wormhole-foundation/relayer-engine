import yargs from "yargs";
import Koa from "koa";
import {
  Context,
  Environment,
  logging,
  LoggingContext,
  providers,
  RelayerApp,
  sourceTx,
  SourceTxContext,
  stagingArea,
  StagingAreaContext,
  StorageContext,
  TokenBridgeContext,
  tokenBridgeContracts,
  Storage,
  RelayJob,
  onJobHandler,
  RedisStorage,
} from "@wormhole-foundation/relayer-engine";
import { rootLogger } from "./log.js";
import { Controller } from "./controller.js";
import { Logger } from "winston";
import { toChainId } from "@wormhole-foundation/sdk";

export class TestStorage extends RedisStorage {
  startWorker(cb: onJobHandler): void {
    console.log("called start worker with", cb);
    return;
  }

  async stopWorker(): Promise<void> {
    return;
  }
  async addVaaToQueue(vaa: Uint8Array): Promise<RelayJob> {
    console.log("adding vaa to queue: ", vaa);
    return {} as RelayJob;
  }
}

export type MyRelayerContext = LoggingContext &
  StorageContext &
  SourceTxContext &
  TokenBridgeContext &
  StagingAreaContext;

async function main(namespace: string) {
  let opts: any = yargs(process.argv.slice(2)).argv;

  const app = new RelayerApp<MyRelayerContext>(Environment.TESTNET);

  const fundsCtrl = new Controller();
  // Config
  const store = new TestStorage({
    attempts: 3,
    namespace,
    queueName: "relays",
  });
  configRelayer(app, store);

  // Set up middleware
  app.use(logging(rootLogger)); // <-- logging middleware
  app.use(providers());
  app.use(tokenBridgeContracts());
  app.use(stagingArea());
  app.use(sourceTx());

  app
    .chain(toChainId("Solana"))
    .address(
      "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      fundsCtrl.redeemVaa
    );

  // passing a function with 3 args will be used to process errors
  // (whenever you throw from your middleware)
  app.use(async (err, ctx, next) => {
    ctx.logger.error("error middleware triggered");
  });

  app.listen();
  feedEm(app);
  runUI(store, opts, rootLogger);
}

async function feedEm(app: RelayerApp<MyRelayerContext>) {
  // rando token transfer VAA from Sol
  setInterval(() => {
    const tmpvaa = Buffer.from(
      "AQAAAAABAJhoIpjSRXkgBWn36i/ULs79LzTVnCusLvAvB27UO8CRB2vhOHrQweHWXnZAoUKpeIZ2VtvmLwSLMvAYa4Oy/SMBZLGAxQAAc38AATsmQJ+Kre0/XdyhhGlapqD6gpsMhcr4SFYySJbSFMqYAAAAAAAAXc8gAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACYloABpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAEAAW2a5rLTM8HWUwGlnaPu04jKXcYMsSSWWEt1y+axX9vtACC+6/ZVk+zI95lF4zZqA44cLkY+fu0ikgdvAuPVrcr6rXsiYmFzaWNfcmVjaXBpZW50Ijp7InJlY2lwaWVudCI6ImMyVnBNV1ptWkd0dGR6Sm1jbkE0TW1zM09EaDZlWGx0Ym5kNWRuSmphemRuY1hremF6Um1OMk5sIn19",
      "base64"
    );
    app.processVaa(tmpvaa);
  }, 1000);
}

function configRelayer<T extends Context>(app: RelayerApp<T>, store: Storage) {
  app.spy("localhost:7073");
  app.useStorage(store);
  app.logger(rootLogger);
}

function runUI(store: RedisStorage, { port }: any, logger: Logger) {
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

main("simple-relayer-example");
