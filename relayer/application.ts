import { EventEmitter } from "events";
import {
  ChainId,
  ChainName,
  coalesceChainId,
  coalesceChainName,
  CONTRACTS,
  getSignedVAAWithRetry,
  ParsedVaa,
  SignedVaa,
} from "@certusone/wormhole-sdk";
import {
  compose,
  composeError,
  ErrorMiddleware,
  Middleware,
  Next,
} from "./compose.middleware";
import { Context } from "./context";
import { Logger } from "winston";
import { BigNumber } from "ethers";
import {
  createSpyRPCServiceClient,
  subscribeSignedVAA,
} from "@certusone/wormhole-spydk";
import { ChainID } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";
import { UnrecoverableError } from "bullmq";
import {
  encodeEmitterAddress,
  mergeDeep,
  parseVaaWithBytes,
  sleep,
} from "./utils";
import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import { defaultLogger } from "./logging";
import { VaaBundleFetcher, VaaId } from "./bundle-fetcher.helper";
import { RelayJob, Storage } from "./storage/storage";
import * as Events from "events";

export enum Environment {
  MAINNET = "mainnet",
  TESTNET = "testnet",
  DEVNET = "devnet",
}

export { UnrecoverableError };

export interface RelayerAppOpts {
  wormholeRpcs?: string[];
  concurrency?: number;
}

export type FetchaVaasOpts = {
  ids: VaaId[];
  delayBetweenRequestsInMs?: number;
  attempts?: number;
};

export const defaultWormholeRpcs = {
  [Environment.MAINNET]: ["https://api.wormscan.io"],
  [Environment.TESTNET]: [
    "https://wormhole-v2-testnet-api.certus.one",
    "https://api.testnet.wormscan.io",
  ],
  [Environment.DEVNET]: [""],
};

const defaultOpts = (env: Environment): RelayerAppOpts => ({
  wormholeRpcs: defaultWormholeRpcs[env],
  concurrency: 1,
});

interface SerializableVaaId {
  emitterChain: ChainId;
  emitterAddress: string;
  sequence: string;
}

export interface ParsedVaaWithBytes extends ParsedVaa {
  id: SerializableVaaId;
  bytes: SignedVaa;
}

export type FilterFN = (
  vaaBytes: ParsedVaaWithBytes,
) => Promise<boolean> | boolean;

export enum RelayerEvents {
  Received = "received",
  Added = "added",
  Skipped = "skipped",
  Completed = "completed",
  Failed = "failed",
}

export type ListenerFn = (vaa: ParsedVaaWithBytes, job?: RelayJob) => void;

export class RelayerApp<ContextT extends Context> extends EventEmitter {
  private pipeline?: Middleware;
  private errorPipeline?: ErrorMiddleware;
  private chainRouters: Partial<Record<ChainId, ChainRouter<ContextT>>> = {};
  private spyUrl?: string;
  private rootLogger: Logger;
  storage: Storage;
  filters: {
    emitterFilter?: { chainId?: ChainID; emitterAddress?: string };
  }[] = [];
  private opts: RelayerAppOpts;
  private vaaFilters: FilterFN[] = [];

  constructor(
    public env: Environment = Environment.TESTNET,
    opts: RelayerAppOpts = {},
  ) {
    super();
    this.opts = mergeDeep({}, [defaultOpts(env), opts]);
  }

  /**
   *  This function will run as soon as a VAA is received and will determine whether we want to process it or skip it.
   *  This is useful if you're listening to a contract but you don't care about every one of the VAAs emitted by it (eg. The Token Bridge contract).
   *
   *  WARNING: If your function throws, the VAA will be skipped (is this the right behavior?). If you want to process the VAA anyway, catch your errors and return true.
   *
   * @param newFilter pass in a function that will receive the raw bytes of the VAA and if it returns `true` or `Promise<true>` the VAA will be processed, otherwise it will be skipped
   */
  filter(newFilter: FilterFN) {
    this.vaaFilters.push(newFilter);
  }

  private async shouldProcessVaa(vaa: ParsedVaaWithBytes): Promise<boolean> {
    if (this.vaaFilters.length === 0) {
      return true;
    }
    for (let i = 0; i < this.vaaFilters.length; i++) {
      const chain = vaa.emitterChain;
      const emitterAddress = vaa.emitterAddress.toString("hex");
      const sequence = vaa.sequence.toString();

      const filter = this.vaaFilters[i];
      let isOk;
      try {
        isOk = await filter(vaa);
      } catch (e: any) {
        isOk = false;
        this.rootLogger.debug(
          `filter ${i} of ${this.vaaFilters.length} threw an exception`,
          {
            chain,
            emitterAddress,
            sequence,
            message: e.message,
            stack: e.stack,
            name: e.name,
          },
        );
      }
      if (!isOk) {
        this.rootLogger.debug(
          `Vaa was skipped by filter ${i} of ${this.vaaFilters.length}`,
          { chain, emitterAddress, sequence },
        );
        return false;
      }
    }
    return true;
  }

  on(eventName: RelayerEvents, listener: ListenerFn): this {
    return super.on(eventName, listener);
  }

  emit(
    eventName: RelayerEvents,
    vaa: ParsedVaaWithBytes,
    job?: RelayJob,
    ...args: any
  ): boolean {
    return super.emit(eventName, vaa, job, ...args);
  }

  /**
   * Allows you to pass an object that specifies a combination of chains with address for which you want to run middleware.
   *
   * @example:
   * ```
   * relayerApp.multiple({[CHAIN_ID_SOLANA]: "mysolanaAddress", [ CHAIN_ID_ETH ]: "0xMyEthAddress" }, middleware1, middleware2)
   * ```
   *
   * This would run `middleware1` and `middleware2` for the address `mysolanaAddress` in Solana and for the address `0xMyEthAddress` in Ethereum.
   * @param chainsAndAddresses
   * @param middleware
   */
  multiple(
    chainsAndAddresses: Partial<{ [k in ChainId]: string[] | string }>,
    ...middleware: Middleware<ContextT>[]
  ): void {
    for (let [chain, addresses] of Object.entries(chainsAndAddresses)) {
      addresses = Array.isArray(addresses) ? addresses : [addresses];
      const chainRouter = this.chain(Number(chain) as ChainId);
      for (const address of addresses) {
        chainRouter.address(address, ...middleware);
      }
    }
  }

  /**
   * Pass in a set of middlewares that will run for each request
   * @example:
   * ```
   * relayerApp.use(logging(logger));
   * ```
   * @param middleware
   */
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
        middleware as ErrorMiddleware<ContextT>[],
      );
      return;
    }

    // adding regular middleware
    if (this.pipeline) {
      (middleware as Middleware<ContextT>[]).unshift(this.pipeline);
    }
    this.pipeline = compose(middleware as Middleware<ContextT>[]);
  }

  fetchVaas(opts: FetchaVaasOpts): Promise<ParsedVaaWithBytes[]> {
    const bundle = new VaaBundleFetcher(this.fetchVaa.bind(this), {
      vaaIds: opts.ids,
      maxAttempts: opts.attempts,
      delayBetweenAttemptsInMs: opts.delayBetweenRequestsInMs,
    });
    return bundle.build();
  }

  /**
   * Fetches a VAA from a wormhole compatible RPC.
   * You can specify how many times to retry in case it fails and how long to wait between retries
   * @param chain emitterChain
   * @param emitterAddress
   * @param sequence
   * @param retryTimeout backoff between retries
   * @param retries number of attempts
   */
  async fetchVaa(
    chain: ChainId | string,
    emitterAddress: Buffer | string,
    sequence: bigint | string | BigNumber,
    {
      retryTimeout = 100,
      retries = 2,
    }: { retryTimeout: number; retries: number } = {
      retryTimeout: 100,
      retries: 2,
    },
  ): Promise<ParsedVaaWithBytes> {
    const res = await getSignedVAAWithRetry(
      this.opts.wormholeRpcs,
      Number(chain) as ChainId,
      emitterAddress.toString("hex"),
      sequence.toString(),
      { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
      retryTimeout,
      retries,
    );

    return parseVaaWithBytes(res.vaaBytes);
  }

  /**
   * processVaa allows you to put a VAA through the pipeline leveraging storage if needed.
   * @param vaa
   * @param opts You can use this to extend the context that will be passed to the middleware
   */
  async processVaa(vaa: Buffer, opts: any = {}) {
    let parsedVaa = parseVaaWithBytes(vaa);
    this.emit(RelayerEvents.Received, parsedVaa);
    if (!(await this.shouldProcessVaa(parsedVaa)) && !opts.force) {
      this.rootLogger?.debug("VAA did not pass filters. Skipping...", {
        emitterChain: parsedVaa.emitterChain,
        emitterAddress: parsedVaa.emitterAddress.toString("hex"),
        sequence: parsedVaa.sequence.toString(),
      });
      this.emit(RelayerEvents.Skipped, parsedVaa);
      return;
    }
    if (this.storage) {
      const job = await this.storage.addVaaToQueue(parsedVaa.bytes);
      this.emit(RelayerEvents.Added, parsedVaa, job);
    } else {
      this.emit(RelayerEvents.Added, parsedVaa);
      await this.pushVaaThroughPipeline(vaa, opts);
    }
  }

  /**
   * Pushes a vaa through the pipeline. Unless you're the storage service you probably want to use `processVaa`.
   * @param vaa
   * @param opts
   */
  private async pushVaaThroughPipeline(
    vaa: SignedVaa,
    opts: any,
  ): Promise<void> {
    const parsedVaa = parseVaaWithBytes(vaa);

    let ctx: Context = {
      config: {
        spyFilters: await this.spyFilters(),
      },
      env: this.env,
      fetchVaa: this.fetchVaa.bind(this),
      fetchVaas: this.fetchVaas.bind(this),
      locals: {},
      on: this.on.bind(this),
      processVaa: this.processVaa.bind(this),
      vaa: parsedVaa,
      vaaBytes: vaa,
    };
    Object.assign(ctx, opts);
    try {
      await this.pipeline?.(ctx, () => {});
      this.emit(RelayerEvents.Completed, parsedVaa, opts?.storage?.job);
    } catch (e) {
      this.errorPipeline?.(e, ctx, () => {});
      this.emit(RelayerEvents.Failed, parsedVaa, opts?.storage?.job);
      throw e;
    }
  }

  /**
   * Gives you a Chain router so you can add middleware on an address.
   * @example:
   * ```
   * relayerApp.chain(CHAIN_ID_ETH).address("0x0001234abcdef...", middleware1, middleware2);
   * ```
   *
   * @param chainId
   */
  chain(chainId: ChainId): ChainRouter<ContextT> {
    if (!this.chainRouters[chainId]) {
      this.chainRouters[chainId] = new ChainRouter(chainId);
    }
    return this.chainRouters[chainId]!;
  }

  /**
   * A convenient shortcut to subscribe to tokenBridge messages.
   * @example:
   * ```
   * relayerApp.tokenBridge(["ethereum", CHAIN_ID_SOLANA], middleware1, middleware2)
   * ```
   *
   * Would run middleware1 and middleware2 for any tokenBridge vaa coming from ethereum or solana.
   *
   * @param chainsOrChain
   * @param handlers
   */
  tokenBridge(
    chainsOrChain: ChainId[] | ChainName[] | ChainId | ChainName,
    ...handlers: Middleware<ContextT>[]
  ) {
    const chains = Array.isArray(chainsOrChain)
      ? chainsOrChain
      : [chainsOrChain];
    for (const chainIdOrName of chains) {
      const chainName = coalesceChainName(chainIdOrName);
      const chainId = coalesceChainId(chainIdOrName);
      let address =
        // @ts-ignore TODO
        CONTRACTS[this.env.toUpperCase()][chainName].token_bridge;
      this.chain(chainId).address(address, ...handlers);
    }
    return this;
  }

  private async spyFilters(): Promise<
    { emitterFilter?: { chainId?: ChainID; emitterAddress?: string } }[]
  > {
    const spyFilters = new Set<any>();
    for (const chainRouter of Object.values(this.chainRouters)) {
      for (const filter of await chainRouter.spyFilters()) {
        spyFilters.add(filter);
      }
    }
    return Array.from(spyFilters.values());
  }

  /**
   * Pass in the URL where you have an instance of the spy listening. Usually localhost:7073
   *
   * You can run the spy locally (for TESTNET) by doing:
   * ```
    docker run \
        --platform=linux/amd64 \
        -p 7073:7073 \
        --entrypoint /guardiand \
        ghcr.io/wormhole-foundation/guardiand:latest \
    spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/testnet/2/1 --bootstrap /dns4/wormhole-testnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWAkB9ynDur1Jtoa97LBUp8RXdhzS5uHgAfdTquJbrbN7i
   * ```
   *
   * You can run the spy locally (for MAINNET) by doing:
   * ```
   docker run \
      --platform=linux/amd64 \
      -p 7073:7073 \
      --entrypoint /guardiand \
      ghcr.io/wormhole-foundation/guardiand:latest \
   spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/mainnet/2 --bootstrap /dns4/wormhole-mainnet-v2-bootstrap.certus.one/udp/8999/quic/p2p/12D3KooWQp644DK27fd3d4Km3jr7gHiuJJ5ZGmy8hH4py7fP4FP7,/dns4/wormhole-v2-mainnet-bootstrap.xlabs.xyz/udp/8999/quic/p2p/12D3KooWNQ9tVrcb64tw6bNs2CaNrUGPM7yRrKvBBheQ5yCyPHKC
   * ```
   * @param url
   */
  spy(url: string) {
    this.spyUrl = url;
    return this;
  }

  /**
   * Set a logger for the relayer app. Not to be confused with a logger for the middleware. This is for when the relayer app needs to log info/error.
   *
   * @param logger
   */
  logger(logger: Logger) {
    this.rootLogger = logger;
  }

  /**
   * Configure your storage by passing info redis connection info among other details.
   * If you are using RelayerApp<any>, and you do not call this method, you will not be using storage.
   * Which means your VAAS will go straight through the pipeline instead of being added to a queue.
   * @param storage
   */
  useStorage(storage: Storage) {
    this.storage = storage;
  }

  private generateChainRoutes(): Middleware<ContextT> {
    return async (ctx: ContextT, next: Next) => {
      let router = this.chainRouters[ctx.vaa.emitterChain as ChainId];
      if (!router) {
        this.rootLogger.error(
          "received a vaa but we don't have a router for it",
        );
        return;
      }
      await router.process(ctx, next);
    };
  }

  /**
   * Connect to the spy and start processing VAAs.
   */
  async listen() {
    this.rootLogger = this.rootLogger ?? defaultLogger;
    this.use(this.generateChainRoutes());

    this.filters = await this.spyFilters();
    this.rootLogger.debug(JSON.stringify(this.filters, null, 2));
    if (this.filters.length > 0 && !this.spyUrl) {
      throw new Error("you need to setup the spy url");
    }

    this.storage?.startWorker(this.onVaaFromQueue);

    while (true) {
      const client = createSpyRPCServiceClient(this.spyUrl!);

      try {
        const stream = await subscribeSignedVAA(client, {
          filters: this.filters,
        });

        this.rootLogger.info(`connected to the spy at: ${this.spyUrl}`);

        for await (const vaa of stream) {
          this.rootLogger.debug(`Received VAA through spy`);
          this.processVaa(vaa.vaaBytes);
        }
      } catch (err) {
        this.rootLogger.error("error connecting to the spy");
      }

      await sleep(300); // wait a bit before trying to reconnect.
    }
  }

  /**
   * Stop the worker from grabbing more jobs and wait until it finishes with the ones that it has.
   */
  stop() {
    return this.storage.stopWorker();
  }

  private onVaaFromQueue = async (job: RelayJob) => {
    await this.pushVaaThroughPipeline(job.data.vaaBytes, { storage: { job } });
    await job.updateProgress(100);
    return [""];
  };
}

class ChainRouter<ContextT extends Context> {
  _addressHandlers: Record<string, Middleware<ContextT>> = {};

  constructor(public chainId: ChainId) {}

  /**
   * Specify an address in native format (eg base58 for solana) and a set of middleware to run when we receive a VAA from that address
   * @param address
   * @param handlers
   */
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
    return addresses.map(address => ({
      emitterFilter: { chainId: this.chainId, emitterAddress: address },
    }));
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
