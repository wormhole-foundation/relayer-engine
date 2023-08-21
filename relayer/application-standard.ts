import { RelayerApp, RelayerAppOpts } from "./application";
import {
  logging,
  LoggingContext,
  spawnMissedVaaWorker,
  providers,
  ProvidersOpts,
  sourceTx,
  SourceTxContext,
  stagingArea,
  StagingAreaContext,
  TokenBridgeContext,
  tokenBridgeContracts,
  WalletContext,
  wallets,
} from "./middleware";
import { Logger } from "winston";
import { StorageContext } from "./storage/storage";
import { ExponentialBackoffOpts, RedisStorage } from "./storage/redis-storage";
import { ChainId } from "@certusone/wormhole-sdk";
import { ClusterNode, ClusterOptions, RedisOptions } from "ioredis";
import { mergeDeep } from "./utils";
import { defaultLogger } from "./logging";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { KoaAdapter } from "@bull-board/koa";
import { createBullBoard } from "@bull-board/api";
import { Environment } from "./environment";
import { TokensByChain } from "./middleware/wallet/wallet-management";
import { Registry } from "prom-client";

export interface StandardMissedVaaOpts {
  concurrency?: number;
  checkInterval?: number;
  fetchVaaRetries?: number;
  vaasFetchConcurrency?: number;
  storagePrefix?: string;
  startingSequenceConfig?: Partial<Record<ChainId, bigint>>;
  forceSeenKeysReindex?: boolean;
}

export interface StandardRelayerAppOpts extends RelayerAppOpts {
  name: string;
  spyEndpoint?: string;
  logger?: Logger;
  privateKeys?: Partial<{
    [k in ChainId]: any[];
  }>;
  tokensByChain?: TokensByChain;
  workflows?: {
    retries: number;
  };
  providers?: ProvidersOpts;
  redisClusterEndpoints?: ClusterNode[];
  redisCluster?: ClusterOptions;
  redis?: RedisOptions;
  fetchSourceTxhash?: boolean;
  retryBackoffOptions?: ExponentialBackoffOpts;
  missedVaaOptions?: StandardMissedVaaOpts;
}

const defaultOpts: Partial<StandardRelayerAppOpts> = {
  spyEndpoint: "localhost:7073",
  workflows: {
    retries: 3,
  },
  fetchSourceTxhash: true,
  logger: defaultLogger,
};

export type StandardRelayerContext = LoggingContext &
  StorageContext &
  TokenBridgeContext &
  StagingAreaContext &
  WalletContext &
  SourceTxContext;

export class StandardRelayerApp<
  ContextT extends StandardRelayerContext = StandardRelayerContext,
> extends RelayerApp<ContextT> {
  private readonly store: RedisStorage;
  private readonly mergedRegistry: Registry;
  constructor(env: Environment, opts: StandardRelayerAppOpts) {
    // take logger out before merging because of recursive call stack
    const logger = opts.logger ?? defaultLogger;
    delete opts.logger;
    // now we can merge
    opts = mergeDeep({}, [defaultOpts, opts]);

    const {
      privateKeys,
      tokensByChain,
      name,
      spyEndpoint,
      redis,
      redisCluster,
      redisClusterEndpoints,
      wormholeRpcs,
      retryBackoffOptions,
    } = opts;
    super(env, opts);

    this.store = new RedisStorage({
      redis,
      redisClusterEndpoints,
      redisCluster,
      attempts: opts.workflows.retries ?? 3,
      namespace: name,
      queueName: `${name}-relays`,
      exponentialBackoff: retryBackoffOptions,
    });

    // this is always true for standard relayer app, but I'm adding this if
    // to make the dependency explicit
    if (this.store) {
      spawnMissedVaaWorker(this, {
        namespace: name,
        registry: this.mergedRegistry,
        logger,
        redis,
        redisCluster,
        redisClusterEndpoints,
        wormholeRpcs,
        concurrency: opts.missedVaaOptions?.concurrency,
        checkInterval: opts.missedVaaOptions?.checkInterval,
        fetchVaaRetries: opts.missedVaaOptions?.fetchVaaRetries,
        vaasFetchConcurrency: opts.missedVaaOptions?.vaasFetchConcurrency,
        storagePrefix: this.store.getPrefix(),
        startingSequenceConfig: opts.missedVaaOptions?.startingSequenceConfig,
        forceSeenKeysReindex: opts.missedVaaOptions?.forceSeenKeysReindex,
      });
    }

    this.mergedRegistry = Registry.merge([
      this.store.registry,
      super.metricsRegistry,
    ]);

    this.spy(spyEndpoint);
    this.useStorage(this.store);
    this.logger(logger);
    this.use(logging(logger)); // <-- logging middleware
    this.use(providers(opts.providers, Object.keys(opts.privateKeys ?? {})));
    if (opts.privateKeys && Object.keys(opts.privateKeys).length) {
      this.use(
        wallets(env, {
          logger,
          namespace: name,
          privateKeys,
          tokensByChain,
          metrics: { enabled: true, registry: this.metricsRegistry },
        }),
      ); // <-- you need valid private keys to turn on this middleware
    }
    this.use(tokenBridgeContracts());
    this.use(
      stagingArea({
        namespace: name,
        redisCluster,
        redis,
        redisClusterEndpoints,
      }),
    );
    if (opts.fetchSourceTxhash) {
      this.use(sourceTx());
    }
  }

  /**
   * Registry with prometheus metrics exported by the relayer.
   * Metrics include:
   * - active_workflows: Number of workflows currently running
   * - delayed_workflows: Number of worklows which are scheduled in the future either because they were scheduled that way or because they failed.
   * - waiting_workflows: Workflows waiting for a worker to pick them up.
   * - worklow_processing_duration: Processing time for completed jobs (processing until completed)
   * - workflow_total_duration: Processing time for completed jobs (processing until completed)
   */
  get metricsRegistry() {
    return this.mergedRegistry;
  }

  /**
   * A UI that you can mount in a KOA app to show the status of the queue / jobs.
   * @param path
   */
  storageKoaUI(path: string) {
    // UI
    const serverAdapter = new KoaAdapter();
    serverAdapter.setBasePath(path);

    createBullBoard({
      queues: [new BullMQAdapter(this.store.vaaQueue)],
      serverAdapter: serverAdapter,
    });

    return serverAdapter.registerPlugin();
  }
}
