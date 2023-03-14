import * as wormholeSdk from "@certusone/wormhole-sdk";
import { ChainId } from "@certusone/wormhole-sdk";
import {
  compose,
  composeError,
  ErrorMiddleware,
  Middleware,
  Next,
} from "./compose.middleware";
import { Context } from "./context";
import * as winston from "winston";
import { Logger } from "winston";

import {
  createSpyRPCServiceClient,
  subscribeSignedVAA,
} from "@certusone/wormhole-spydk";
import { bech32 } from "bech32";
import { deriveWormholeEmitterKey } from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import { zeroPad } from "ethers/lib/utils";
import { Storage, StorageOptions } from "./storage";
import { KoaAdapter } from "@bull-board/koa";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ChainID } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";
import { UnrecoverableError } from "bullmq";

const defaultLogger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      level: "debug",
    }),
  ],
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.splat(),
    winston.format.simple(),
    winston.format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss.SSS",
    }),
    winston.format.errors({ stack: true })
  ),
});

export enum Environment {
  MAINNET = "mainnet",
  TESTNET = "testnet",
  DEVNET = "devnet",
}

export { UnrecoverableError };

export class RelayerApp<ContextT extends Context> {
  private pipeline?: Middleware<Context>;
  private errorPipeline?: ErrorMiddleware<Context>;
  private chainRouters: Partial<Record<ChainId, ChainRouter<ContextT>>> = {};
  private spyUrl?: string;
  private rootLogger: Logger;
  storage: Storage<ContextT>;
  filters: {
    emitterFilter?: { chainId?: ChainID; emitterAddress?: string };
  }[];

  constructor(public env: Environment = Environment.TESTNET) {}

  use(...middleware: Middleware<ContextT>[] | ErrorMiddleware<ContextT>[]) {
    if (!middleware.length) {
      return;
    }

    // adding error middleware
    if (middleware[0].length > 2) {
      if (this.errorPipeline) {
        (middleware as ErrorMiddleware<ContextT>[]).unshift(this.errorPipeline);
      }
      this.errorPipeline = composeError(
        middleware as ErrorMiddleware<ContextT>[]
      );
      return;
    }

    // adding regular middleware
    if (this.pipeline) {
      (middleware as Middleware<ContextT>[]).unshift(this.pipeline);
    }
    this.pipeline = compose(middleware as Middleware<ContextT>[]);
  }

  async processVaa(vaa: Buffer, opts?: any) {
    if (this.storage) {
      await this.storage.addVaaToQueue(vaa);
    } else {
      this.pushVaaThroughPipeline(vaa).catch((err) => {}); // error already handled by middleware, catch to swallow remaining error.
    }
  }

  async pushVaaThroughPipeline(vaa: Buffer, opts?: any): Promise<void> {
    const parsedVaa = wormholeSdk.parseVaa(vaa);
    let ctx: Context = {
      vaa: parsedVaa,
      vaaBytes: vaa,
      env: this.env,
      processVaa: this.processVaa.bind(this),
      config: {
        spyFilters: await this.spyFilters(),
      },
    };
    Object.assign(ctx, opts);
    try {
      await this.pipeline?.(ctx, () => {});
    } catch (e) {
      this.errorPipeline?.(e, ctx, () => {});
      throw e;
    }
  }

  chain(chainId: ChainId): ChainRouter<ContextT> {
    if (!this.chainRouters[chainId]) {
      this.chainRouters[chainId] = new ChainRouter(chainId);
    }
    return this.chainRouters[chainId]!;
  }

  private async spyFilters(): Promise<
    { emitterFilter?: { chainId?: ChainID; emitterAddress?: string } }[]
  > {
    const spyFilters = new Set<any>();
    for (const [chainId, chainRouter] of Object.entries(this.chainRouters)) {
      for (const filter of await chainRouter.spyFilters()) {
        spyFilters.add(filter);
      }
    }
    return Array.from(spyFilters.values());
  }

  spy(url: string) {
    this.spyUrl = url;
    return this;
  }

  logger(logger: Logger) {
    this.rootLogger = logger;
    if (this.storage) {
      this.storage.logger = logger;
    }
  }

  useStorage(storageOptions: StorageOptions) {
    this.storage = new Storage(this, storageOptions);
    if (this.rootLogger) {
      this.storage.logger = this.rootLogger;
    }
  }

  storageKoaUI(path: string) {
    // UI
    const serverAdapter = new KoaAdapter();
    serverAdapter.setBasePath(path);

    createBullBoard({
      queues: [new BullMQAdapter(this.storage.vaaQueue)],
      serverAdapter: serverAdapter,
    });

    return serverAdapter.registerPlugin();
  }

  private generateChainRoutes(): Middleware<ContextT> {
    let chainRouting = async (ctx: ContextT, next: Next) => {
      let router = this.chainRouters[ctx.vaa.emitterChain as ChainId];
      if (!router) {
        this.rootLogger.error(
          "received a vaa but we don't have a router for it"
        );
        return;
      }
      await router.process(ctx, next);
    };
    return chainRouting;
  }

  async listen() {
    this.rootLogger = this.rootLogger ?? defaultLogger;
    if (this.storage && !this.storage.logger) {
      this.storage.logger = this.rootLogger;
    }
    this.use(this.generateChainRoutes());

    this.filters = await this.spyFilters();
    if (this.filters.length > 0 && !this.spyUrl) {
      throw new Error("you need to setup the spy url");
    }

    this.storage?.startWorker();

    while (true) {
      const client = createSpyRPCServiceClient(this.spyUrl!);

      try {
        const stream = await subscribeSignedVAA(client, {
          filters: this.filters,
        });

        this.rootLogger.info("connected to the spy");

        for await (const vaa of stream) {
          this.processVaa(vaa.vaaBytes).catch();
        }
      } catch (err) {
        this.rootLogger.error("error connecting to the spy");
      }

      await sleep(300); // wait a bit before trying to reconnect.
    }
  }

  public environment(env: Environment) {
    this.env = env;
  }
}

class ChainRouter<ContextT extends Context> {
  _addressHandlers: Record<string, Middleware<ContextT>> = {};

  constructor(public chainId: ChainId) {}

  address = (
    address: string,
    ...handlers: Middleware<ContextT>[]
  ): ChainRouter<ContextT> => {
    address = encodeEmitterAddress(this.chainId, address);
    if (!this._addressHandlers[address]) {
      this._addressHandlers[address] = compose(handlers);
    } else {
      this._addressHandlers[address] = compose([
        this._addressHandlers[address],
        ...handlers,
      ]);
    }
    return this;
  };

  spyFilters(): { emitterFilter: ContractFilter }[] {
    let addresses = Object.keys(this._addressHandlers);
    const filters = addresses.map((address) => ({
      emitterFilter: { chainId: this.chainId, emitterAddress: address },
    }));
    return filters;
  }

  async process(ctx: ContextT, next: Next): Promise<void> {
    let addr = ctx.vaa!.emitterAddress.toString("hex");
    let handler = this._addressHandlers[addr];
    if (!handler) {
      throw new Error("route undefined");
    }
    return handler?.(ctx, next);
  }
}

export type ContractFilter = {
  emitterAddress: string; // Emitter contract address to filter for
  chainId: ChainId; // Wormhole ChainID to filter for
};

function encodeEmitterAddress(
  myChainId: wormholeSdk.ChainId,
  emitterAddressStr: string
): string {
  if (
    myChainId === wormholeSdk.CHAIN_ID_SOLANA ||
    myChainId === wormholeSdk.CHAIN_ID_PYTHNET
  ) {
    return deriveWormholeEmitterKey(emitterAddressStr)
      .toBuffer()
      .toString("hex");
  }
  if (wormholeSdk.isTerraChain(myChainId)) {
    return Buffer.from(
      zeroPad(bech32.fromWords(bech32.decode(emitterAddressStr).words), 32)
    ).toString("hex");
  }
  if (wormholeSdk.isEVMChain(myChainId)) {
    return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
  }
  throw new Error(`Unrecognized wormhole chainId ${myChainId}`);
}

export function sleep(ms: number) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}
