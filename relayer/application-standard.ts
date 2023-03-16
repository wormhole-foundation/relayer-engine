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
import { defaultLogger } from "./logging";
import { StorageContext } from "./storage";
import { ChainId } from "@certusone/wormhole-sdk";
import { ClusterNode, ClusterOptions, RedisOptions } from "ioredis";
import { mergeDeep } from "./utils";

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
}

const defaultOpts: Partial<StandardRelayerAppOpts> = {
  spyEndpoint: "localhost:7373",
  workflows: {
    retries: 3,
  },
};

export type StandardRelayerContext = LoggingContext &
  StorageContext &
  TokenBridgeContext &
  StagingAreaContext &
  WalletContext;

export class StandardRelayerApp<
  ContextT extends StandardRelayerContext = StandardRelayerContext
> extends RelayerApp<ContextT> {
  constructor(env: Environment, opts: StandardRelayerAppOpts) {
    opts = mergeDeep({},defaultOpts, opts);
    opts.logger = opts.logger || defaultLogger;

    const { logger, privateKeys, name, spyEndpoint, redis, redisCluster, redisClusterEndpoints } =
      opts;
    super(env, opts);
    this.spy(spyEndpoint);
    this.useStorage({
      redis,
      redisClusterEndpoints,
      redisCluster,
      attempts: opts.workflows.retries ?? 3,
      namespace: name,
      queueName: `${name}-relays`,
    });
    this.logger(opts.logger);
    this.use(logging(opts.logger)); // <-- logging middleware
    this.use(
      missedVaas(this, { namespace: name, logger, redis, redisCluster, redisClusterEndpoints })
    );
    this.use(providers());
    if (opts.privateKeys && Object.keys(opts.privateKeys).length) {
      this.use(wallets({ logger, namespace: name, privateKeys })); // <-- you need valid private keys to turn on this middleware
    }
    this.use(tokenBridgeContracts());
    this.use(stagingArea({ namespace: name, redisCluster, redis, redisClusterEndpoints }));
  }
}
