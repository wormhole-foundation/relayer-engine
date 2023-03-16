import { StorageContext } from "wormhole-relayer";
import { LoggingContext } from "wormhole-relayer/middleware/logger.middleware";
import { TokenBridgeContext } from "wormhole-relayer/middleware/tokenBridge.middleware";
import { StagingAreaContext } from "wormhole-relayer/middleware/staging-area.middleware";
import { WalletContext } from "wormhole-relayer/middleware/wallet/wallet.middleware";
export type MyRelayerContext = LoggingContext & StorageContext & TokenBridgeContext & StagingAreaContext & WalletContext;
