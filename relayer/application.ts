import {
  createSpyRPCServiceClient,
  subscribeSignedVAA,
} from "@certusone/wormhole-spydk";
import { SpyRPCServiceClient } from "@certusone/wormhole-spydk/lib/cjs/proto/spy/v1/spy.js";
import {
  api,
  Chain,
  ChainId,
  contracts,
  Network,
  serialize,
  toChain,
  toChainId,
  UniversalAddress,
  VAA,
  WormholeMessageId,
} from "@wormhole-foundation/sdk";
import { UnrecoverableError } from "bullmq";
import { EventEmitter } from "events";
import { LRUCache } from "lru-cache";
import { Registry } from "prom-client";
import { Logger } from "winston";
import { createRelayerMetrics, RelayerMetrics } from "./application.metrics.js";
import { VaaBundleFetcher, VaaId } from "./bundle-fetcher.helper.js";
import {
  compose,
  composeError,
  ErrorMiddleware,
  isErrorMiddlewareList,
  Middleware,
  Next,
} from "./compose.middleware.js";
import { emitterCapByEnv } from "./configs/sui.js";
import { Context, FetchVaaFn } from "./context.js";
import { Environment } from "./environment.js";
import { defaultLogger } from "./logging.js";
import { RelayJob, Storage } from "./storage/storage.js";
import {
  encodeEmitterAddress,
  mergeDeep,
  parseVaaWithBytes,
  toSerializableId,
} from "./utils.js";

export { UnrecoverableError };

export interface RelayerAppOpts {
  wormholeRpcs: string[];
  concurrency: number;
}

export type FetchaVaasOpts = {
  ids: VaaId[];
  delayBetweenRequestsInMs?: number;
  attempts?: number;
};

export const defaultWormholeRpcs = {
  [Environment.MAINNET]: ["https://api.wormholescan.io"],
  [Environment.TESTNET]: ["https://api.testnet.wormholescan.io"],
  [Environment.DEVNET]: [""],
};

export const defaultWormscanUrl = {
  [Environment.MAINNET]: "https://api.wormholescan.io",
  [Environment.TESTNET]: "https://api.testnet.wormholescan.io",
  [Environment.DEVNET]: "https://api.testnet.wormholescan.io",
};

export const defaultOpts = (env: Environment) =>
  ({
    wormholeRpcs: defaultWormholeRpcs[env],
    concurrency: 1,
  } satisfies RelayerAppOpts);

export interface SerializableVaaId {
  emitterChain: ChainId;
  emitterAddress: string;
  sequence: string;
}

export interface ParsedVaaWithBytes extends VAA {
  id: SerializableVaaId;
  bytes: Uint8Array;
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
  storage?: Storage;
  filters: {
    emitterFilter?: { chainId?: ChainId; emitterAddress?: string };
  }[] = [];
  private pipeline?: Middleware<ContextT>;
  private errorPipeline?: ErrorMiddleware<ContextT>;
  private chainRouters: Partial<Record<ChainId, ChainRouter<ContextT>>> = {};
  private spyUrl?: string;
  private rootLogger?: Logger;
  private opts: RelayerAppOpts;
  private vaaFilters: FilterFN[] = [];
  private alreadyFilteredCache = new LRUCache<string, boolean>({ max: 1000 });
  private metrics: RelayerMetrics;
  private registry: Registry;

  constructor(
    public env: Environment = Environment.TESTNET,
    opts: Partial<RelayerAppOpts> = {},
  ) {
    super();
    this.opts = mergeDeep({}, [defaultOpts(env), opts]);
    const { metrics, registry } = createRelayerMetrics();
    this.metrics = metrics;
    this.registry = registry;
  }

  get metricsRegistry(): Registry {
    return this.registry;
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
    const { emitterChain, emitterAddress, sequence } = vaa.id;
    const id = `${emitterChain}-${emitterAddress}-${sequence}`;
    if (this.alreadyFilteredCache.get(id)) {
      return false;
    }
    for (let i = 0; i < this.vaaFilters.length; i++) {
      const { emitterChain, emitterAddress, sequence } = vaa.id;
      const filter = this.vaaFilters[i];
      let isOk;
      try {
        isOk = await filter(vaa);
      } catch (e: any) {
        isOk = false;
        this.rootLogger?.debug(
          `filter ${i} of ${this.vaaFilters.length} threw an exception`,
          {
            emitterChain,
            emitterAddress,
            sequence,
            message: e.message,
            stack: e.stack,
            name: e.name,
          },
        );
      }
      if (!isOk) {
        this.alreadyFilteredCache.set(id, true);
        this.rootLogger?.debug(
          `Vaa was skipped by filter ${i + 1} of ${this.vaaFilters.length}`,
          { emitterChain, emitterAddress, sequence },
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
    if (middleware.length === 0) {
      return;
    }

    // TODO: actually check that we don't receive a mixed list of middleware?
    // Only useful if we think we have JS only consumers

    // adding error middleware
    if (isErrorMiddlewareList<ContextT>(middleware)) {
      if (this.errorPipeline) {
        middleware.unshift(this.errorPipeline);
      }
      this.errorPipeline = composeError(middleware);
      return;
    }

    // adding regular middleware
    if (this.pipeline !== undefined) {
      middleware.unshift(this.pipeline);
    }
    this.pipeline = compose(middleware);
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
  public readonly fetchVaa: FetchVaaFn = async function fetchVaa(
    this: RelayerApp<ContextT>,
    chain,
    emitterAddress,
    sequence,
    { retryTimeout = 100, retries = 2 } = {
      retryTimeout: 100,
      retries: 2,
    },
  ): Promise<ParsedVaaWithBytes> {
    const whm: WormholeMessageId = {
      chain: toChain(chain),
      emitter: new UniversalAddress(emitterAddress),
      sequence: BigInt(sequence),
    };

    const vaa = await api.getVaaWithRetry(
      this.opts.wormholeRpcs[0],
      whm,
      "Uint8Array",
      retryTimeout * retries,
    );
    if (!vaa) throw new Error("VAA not found");

    return { id: toSerializableId(whm), bytes: serialize(vaa), ...vaa };
  };

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
        emitterAddress: parsedVaa.emitterAddress.toString(),
        sequence: parsedVaa.sequence.toString(),
      });
      this.emit(RelayerEvents.Skipped, parsedVaa);
      return;
    }
    if (this.storage) {
      const job = await this.storage.addVaaToQueue(parsedVaa.bytes);
      // TODO: it would be ideal to only emit the added event only in
      // the cases the job was actually added (not already in queue)
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
    vaa: Uint8Array,
    opts: any,
  ): Promise<void> {
    const parsedVaa = parseVaaWithBytes(vaa);

    const ctx: Context = {
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
    const ctxt = Object.assign(ctx, opts) as ContextT;
    try {
      await this.pipeline?.(ctxt, () => {});
      this.emit(RelayerEvents.Completed, parsedVaa, opts?.storage?.job);
    } catch (e) {
      this.errorPipeline?.(e as Error, ctxt, () => {});
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
    chainsOrChain: ChainId[] | Chain[] | ChainId | Chain,
    ...handlers: Middleware<ContextT>[]
  ) {
    const chains = Array.isArray(chainsOrChain)
      ? chainsOrChain
      : [chainsOrChain];

    for (const chainIdOrName of chains) {
      const chainName = toChain(chainIdOrName);
      const chainId = toChainId(chainIdOrName);
      const env = this.env.toUpperCase() as Network;
      const address =
        chainName === "Sui"
          ? emitterCapByEnv[this.env] // sui is different from evm in that you can't use the package id or state id, you have to use the emitter cap
          : contracts.tokenBridge.get(env, chainName);

      if (address === undefined) {
        throw new Error("Could not find token bridge address.");
      }
      this.chain(chainId).address(address, ...handlers);
    }
    return this;
  }

  private async spyFilters(): Promise<
    { emitterFilter?: { chainId?: ChainId; emitterAddress?: string } }[]
  > {
    const spyFilters = new Set<any>();
    for (const chainRouter of Object.values(this.chainRouters)) {
      for (const filter of chainRouter.spyFilters()) {
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
     spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/testnet/2/1 --bootstrap 'dns4/t-guardian-01.nodes.stable.io/udp/8999/quic/p2p/12D3KooWCW3LGUtkCVkHZmVSZHzL3C4WRKWfqAiJPz1NR7dT9Bxh,/dns4/t-guardian-02.nodes.stable.io/udp/8999/quic/p2p/12D3KooWJXA6goBCiWM8ucjzc4jVUBSqL9Rri6UpjHbkMPErz5zK'
     * ```
     *
     * You can run the spy locally (for MAINNET) by doing:
     * ```
     docker run \
     --platform=linux/amd64 \
     -p 7073:7073 \
     --entrypoint /guardiand \
     ghcr.io/wormhole-foundation/guardiand:latest \
     spy --nodeKey /node.key --spyRPC "[::]:7073" --network /wormhole/mainnet/2 --bootstrap '/dns4/wormhole-v2-mainnet-bootstrap.xlabs.xyz/udp/8999/quic/p2p/12D3KooWNQ9tVrcb64tw6bNs2CaNrUGPM7yRrKvBBheQ5yCyPHKC,/dns4/wormhole.mcf.rocks/udp/8999/quic/p2p/12D3KooWDZVv7BhZ8yFLkarNdaSWaB43D6UbQwExJ8nnGAEmfHcU,/dns4/wormhole-v2-mainnet-bootstrap.staking.fund/udp/8999/quic/p2p/12D3KooWG8obDX9DNi1KUwZNu9xkGwfKqTp2GFwuuHpWZ3nQruS1'
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
      if (ctx.vaa === undefined) {
        throw new Error("No VAA in context.");
      }
      const router = this.chainRouters[toChainId(ctx.vaa.emitterChain)];
      if (!router) {
        this.rootLogger?.error(
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
    this.metrics.spySubscribedFilters.set(this.filters.length);
    this.rootLogger.debug(JSON.stringify(this.filters, null, 2));
    if (this.filters.length > 0 && !this.spyUrl) {
      throw new Error("you need to setup the spy url");
    }

    this.storage?.startWorker(this.onVaaFromQueue);

    // we retry connecting every 1 second. So if attempts is 10, we've been trying to connect for 10 seconds.
    let attempts = 0;
    while (true) {
      try {
        const client: SpyRPCServiceClient = createSpyRPCServiceClient(
          this.spyUrl!,
        );
        await this.waitForReady(client);

        this.rootLogger.info(`connected to the spy at: ${this.spyUrl}`);

        attempts = 0;
        const stream = await subscribeSignedVAA(client, {
          // @ts-ignore spy sdk uses ChainID but js uses ChainId...
          filters: this.filters,
        });

        for await (const vaa of stream) {
          this.rootLogger.debug(`Received VAA through spy`);
          this.metrics.lastVaaReceived.set(Date.now());
          this.metrics.vaasViaSpyTotal.inc();
          this.processVaa(vaa.vaaBytes);
        }
      } catch (err) {
        attempts++;
        this.rootLogger.error(
          `error connecting to the spy ${
            this.spyUrl
          }. Down for: ${secondsToHuman(attempts)}...`,
        );
      }
    }
  }

  private waitForReady(client: SpyRPCServiceClient): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = new Date();
      deadline.setSeconds(deadline.getSeconds() + 1); // TODO parametrize wait time
      client.waitForReady(deadline, err => {
        if (err) {
          this.metrics.connectedSpies.set(0);
          reject(err);
        } else {
          this.metrics.connectedSpies.set(1);
          resolve(undefined);
        }
      });
    });
  }

  /**
   * Stop the worker from grabbing more jobs and wait until it finishes with the ones that it has.
   */
  stop() {
    return this.storage?.stopWorker();
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
    let addr = ctx.vaa!.emitterAddress.toString();
    let handler = this._addressHandlers[addr];
    if (!handler) {
      throw new Error("route undefined");
    }
    return handler?.(ctx, next);
  }
}

// from: https://stackoverflow.com/questions/8211744/convert-time-interval-given-in-seconds-into-more-human-readable-form
/**
 * Translates seconds into human readable format of seconds, minutes, hours, days, and years
 *
 * @param  seconds The number of seconds to be processed
 * @return         The phrase describing the amount of time
 */
function secondsToHuman(seconds: number): string {
  const levels: [number, string][] = [
    [Math.floor(seconds / 31536000), "years"],
    [Math.floor((seconds % 31536000) / 86400), "days"],
    [Math.floor(((seconds % 31536000) % 86400) / 3600), "hours"],
    [Math.floor((((seconds % 31536000) % 86400) % 3600) / 60), "minutes"],
    [(((seconds % 31536000) % 86400) % 3600) % 60, "seconds"],
  ];
  let returntext = "";

  for (let i = 0, max = levels.length; i < max; i++) {
    if (levels[i][0] === 0) continue;
    returntext += ` ${levels[i][0]} ${
      levels[i][0] === 1
        ? levels[i][1].substr(0, levels[i][1].length - 1)
        : levels[i][1]
    }`;
  }
  return returntext.trim();
}

export type ContractFilter = {
  emitterAddress: string; // Emitter contract address to filter for
  chainId: ChainId; // Wormhole ChainID to filter for
};
