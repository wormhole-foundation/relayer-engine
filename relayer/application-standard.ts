import { Environment, RelayerApp, RelayerAppOpts } from "./application";
import { logging, LoggingContext } from "./middleware/logger.middleware";
import { missedVaas } from "./middleware/missedVaas.middleware";
import { providers, ProvidersOpts } from "./middleware/providers.middleware";
import { WalletContext, wallets } from "./middleware/wallet/wallet.middleware";
import {
  TokenBridgeContext,
  tokenBridgeContracts,
} from "./middleware/tokenBridge.middleware";
import {
  stagingArea,
  StagingAreaContext,
} from "./middleware/staging-area.middleware";
import { Logger } from "winston";
import { StorageContext } from "./storage/storage";
import { RedisStorage } from "./storage/redis-storage";
import { ChainId } from "@certusone/wormhole-sdk";
import { ClusterNode, ClusterOptions, RedisOptions } from "ioredis";
import { mergeDeep } from "./utils";
import { sourceTx, SourceTxContext } from "./middleware/source-tx.middleware";
import { defaultLogger } from "./logging";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { KoaAdapter } from "@bull-board/koa";
import { createBullBoard } from "@bull-board/api";

export interface StandardRelayerAppOpts extends RelayerAppOpts {
  name: string;
  spyEndpoint?: string;
  logger?: Logger;
  privateKeys?: Partial<{
    [k in ChainId]: any[];
  }>;
  workflows?: {
    retries: number;
  };
  providers?: ProvidersOpts;
  redisClusterEndpoints?: ClusterNode[];
  redisCluster?: ClusterOptions;
  redis?: RedisOptions;
  fetchSourceTxhash?: boolean;
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
  private store: RedisStorage;
  constructor(env: Environment, opts: StandardRelayerAppOpts) {
    // take logger out before merging because of recursive call stack
    const logger = opts.logger;
    delete opts.logger;
    // now we can merge
    opts = mergeDeep({}, [defaultOpts, opts]);

    const {
      privateKeys,
      name,
      spyEndpoint,
      redis,
      redisCluster,
      redisClusterEndpoints,
      wormholeRpcs,
    } = opts;
    super(env, opts);

    this.store = new RedisStorage({
      redis,
      redisClusterEndpoints,
      redisCluster,
      attempts: opts.workflows.retries ?? 3,
      namespace: name,
      queueName: `${name}-relays`,
    });

    this.spy(spyEndpoint);
    this.useStorage(this.store);
    this.logger(logger);
    this.use(logging(logger)); // <-- logging middleware
    this.use(
      missedVaas(this, {
        namespace: name,
        logger,
        redis,
        redisCluster,
        redisClusterEndpoints,
        wormholeRpcs,
      }),
    );
    this.use(providers(opts.providers));
    if (opts.privateKeys && Object.keys(opts.privateKeys).length) {
      this.use(wallets({ logger, namespace: name, privateKeys })); // <-- you need valid private keys to turn on this middleware
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
