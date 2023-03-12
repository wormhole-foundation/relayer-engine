import * as wormholeSdk from "@certusone/wormhole-sdk";
import { ChainId } from "@certusone/wormhole-sdk";
import { compose, Middleware, Next } from "./compose.middleware";
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

export class RelayerApp<ContextT extends Context> {
  private pipeline?: Middleware<Context>;
  private chainRouters: Partial<Record<ChainId, ChainRouter<ContextT>>> = {};
  private spyUrl?: string;
  private rootLogger: Logger;
  storage: Storage<ContextT>;

  constructor() {}

  use(...middleware: Middleware<ContextT>[]) {
    if (this.pipeline) {
      middleware.unshift(this.pipeline);
    }
    this.pipeline = compose(middleware);
  }

  handleVaa(vaa: Buffer): Promise<void> {
    const parsedVaa = wormholeSdk.parseVaa(vaa);
    let ctx = new Context(this);
    ctx.vaa = parsedVaa;
    ctx.vaaBytes = vaa;
    return this.pipeline?.(ctx, () => {});
  }

  chain(chainId: ChainId): ChainRouter<ContextT> {
    if (!this.chainRouters[chainId]) {
      this.chainRouters[chainId] = new ChainRouter(chainId);
    }
    return this.chainRouters[chainId]!;
  }

  private async spyFilters() {
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

    let filters = await this.spyFilters();
    if (filters.length > 0 && !this.spyUrl) {
      throw new Error("you need to setup the spy url");
    }

    this.storage?.startWorker();

    while (true) {
      const client = createSpyRPCServiceClient(this.spyUrl!);

      try {
        const stream = await subscribeSignedVAA(client, {
          filters,
        });

        this.rootLogger.info("connected to the spy");

        for await (const vaa of stream) {
          if (this.storage) {
            this.storage.addVaaToQueue(vaa.vaaBytes);
          } else {
            this.handleVaa(vaa.vaaBytes);
          }
        }
      } catch (err) {
        this.rootLogger.error("error connecting to the spy");
      }

      await sleep(300); // wait a bit before trying to reconnect.
    }
  }
}

class ChainRouter<ContextT extends Context> {
  _routes: Record<string, VaaRoute<ContextT>> = {};

  constructor(public chainId: ChainId) {}

  address = (
    address: string,
    ...handlers: Middleware<ContextT>[]
  ): ChainRouter<ContextT> => {
    address = encodeEmitterAddress(this.chainId, address);
    if (!this._routes[address]) {
      const route = new VaaRoute(this.chainId, address, handlers);
      this._routes[address] = route;
    } else {
      this._routes[address]!.addMiddleware(handlers);
    }
    return this;
  };

  spyFilters = (): { emitterFilter: ContractFilter }[] => {
    return this.routes().map((route) => route.spyFilter());
  };

  routes = (): VaaRoute<ContextT>[] => {
    return Object.values(this._routes);
  };

  async process(ctx: ContextT, next: Next): Promise<void> {
    let addr = ctx.vaa!.emitterAddress.toString("hex");
    let route = this._routes[addr];

    await route.execute(ctx, next);
  }
}

class VaaRoute<ContextT extends Context> {
  private handler: Middleware<ContextT>;

  constructor(
    public chainId: ChainId,
    public address: string,
    handlers: Middleware<ContextT>[]
  ) {
    this.handler = compose<ContextT>(handlers);
  }

  execute(ctx: ContextT, next: Next): Promise<void> {
    return this.handler(ctx, next);
  }

  addMiddleware(handlers: Middleware<ContextT>[]) {
    this.handler = compose<ContextT>([this.handler, ...handlers]);
  }

  spyFilter(): { emitterFilter: ContractFilter } {
    const filter = {
      chainId: this.chainId,
      emitterAddress: this.address,
    };
    return { emitterFilter: filter };
  }
}

export type ContractFilter = {
  emitterAddress: string; // Emitter contract address to filter for
  chainId: ChainId; // Wormhole ChainID to filter for
};

export function transformEmitterFilter(x: ContractFilter): ContractFilter {
  return {
    chainId: x.chainId,
    emitterAddress: encodeEmitterAddress(x.chainId, x.emitterAddress),
  };
}

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
