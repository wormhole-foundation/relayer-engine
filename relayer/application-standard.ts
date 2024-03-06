import { ChainId } from "@wormhole-foundation/sdk";
import { RelayerApp, RelayerAppOpts, defaultOpts } from "./application.js";
import {
  logging,
  LoggingContext,
  providers,
  ProvidersOpts,
  sourceTx,
  SourceTxContext,
  spawnMissedVaaWorker,
  stagingArea,
  StagingAreaContext,
  TokenBridgeContext,
  tokenBridgeContracts,
  WalletContext,
  wallets,
} from "./middleware/index.js";
import { Logger } from "winston";
import { StorageContext } from "./storage/storage.js";
import {
  ExponentialBackoffOpts,
  RedisStorage,
} from "./storage/redis-storage.js";
import { ClusterNode, ClusterOptions, RedisOptions } from "ioredis";
import { MakeOptional, mergeDeep } from "./utils.js";
import { defaultLogger } from "./logging.js";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { KoaAdapter } from "@bull-board/koa";
import { createBullBoard } from "@bull-board/api";
import { Environment } from "./environment.js";
import { TokensByChain } from "./middleware/wallet/wallet-management.js";
import { Registry } from "prom-client";
import Koa from "koa";

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
  spyEndpoint: string;
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
  maxCompletedQueueSize?: number;
  maxFailedQueueSize?: number;
}

const defaultStdOpts = {
  spyEndpoint: "localhost:7073",
  workflows: {
    retries: 3,
  },
  fetchSourceTxhash: true,
  logger: defaultLogger,
} satisfies Partial<StandardRelayerAppOpts>;

type FullDefaultOpts = typeof defaultStdOpts & ReturnType<typeof defaultOpts>;

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

  constructor(
    env: Environment,
    opts: MakeOptional<StandardRelayerAppOpts, FullDefaultOpts>,
  ) {
    // take logger out before merging because of recursive call stack
    const logger = opts.logger ?? defaultLogger;
    delete opts.logger;
    // now we can merge
    const options = mergeDeep<StandardRelayerAppOpts>({}, [
      defaultStdOpts,
      opts,
    ]);

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
      maxCompletedQueueSize,
      maxFailedQueueSize,
    } = options;
    super(env, options);

    this.store = new RedisStorage({
      redis,
      redisClusterEndpoints,
      redisCluster,
      attempts: options.workflows?.retries ?? 3,
      namespace: name,
      queueName: `${name}-relays`,
      exponentialBackoff: retryBackoffOptions,
      maxCompletedQueueSize,
      maxFailedQueueSize,
    });

    // this is always true for standard relayer app, but I'm adding this if
    // to make the dependency explicit
    if (this.store) {
      spawnMissedVaaWorker(this, {
        namespace: name,
        registry: this.store.registry,
        logger,
        redis,
        redisCluster,
        redisClusterEndpoints,
        wormholeRpcs,
        concurrency: options.missedVaaOptions?.concurrency,
        checkInterval: options.missedVaaOptions?.checkInterval,
        fetchVaaRetries: options.missedVaaOptions?.fetchVaaRetries,
        vaasFetchConcurrency: options.missedVaaOptions?.vaasFetchConcurrency,
        storagePrefix: this.store.getPrefix(),
        startingSequenceConfig:
          options.missedVaaOptions?.startingSequenceConfig,
        forceSeenKeysReindex: options.missedVaaOptions?.forceSeenKeysReindex,
      });
    }

    this.mergedRegistry = Registry.merge([
      this.store.registry,
      super.metricsRegistry,
    ]);

    this.spy(spyEndpoint);
    this.useStorage(this.store);
    this.logger(logger);
    this.use(logging(logger));
    this.use(providers(options.providers, Object.keys(privateKeys ?? {})));

    // You need valid private keys to turn on the wallet middleware
    if (privateKeys !== undefined && Object.keys(privateKeys).length > 0) {
      this.use(
        wallets(env, {
          logger,
          namespace: name,
          privateKeys,
          tokensByChain,
          metrics: { enabled: true, registry: this.metricsRegistry },
        }),
      );
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
    if (options.fetchSourceTxhash) {
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
  storageKoaUI(
    path: string,
  ): Koa.Middleware<Koa.DefaultState, Koa.DefaultContext, any> {
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
