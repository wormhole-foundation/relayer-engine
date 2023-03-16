import { Environment, RelayerApp, RelayerAppOpts } from "./application";
import { LoggingContext } from "./middleware/logger.middleware";
import { ProvidersOpts } from "./middleware/providers.middleware";
import { WalletContext } from "./middleware/wallet/wallet.middleware";
import { TokenBridgeContext } from "./middleware/tokenBridge.middleware";
import { StagingAreaContext } from "./middleware/staging-area.middleware";
import { Logger } from "winston";
import { StorageContext } from "./storage";
import { ChainId } from "@certusone/wormhole-sdk";
import { ClusterNode, RedisOptions } from "ioredis";
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
    redisCluster?: ClusterNode[];
    redis?: RedisOptions;
}
export declare type StandardRelayerContext = LoggingContext & StorageContext & TokenBridgeContext & StagingAreaContext & WalletContext;
export declare class StandardRelayerApp<ContextT extends StandardRelayerContext = StandardRelayerContext> extends RelayerApp<ContextT> {
    constructor(env: Environment, opts: StandardRelayerAppOpts);
}
