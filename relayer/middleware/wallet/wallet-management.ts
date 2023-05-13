import {
  WalletManager,
  WalletManagerConfig,
  WalletManagerOptions,
} from "@xlabs-xyz/wallet-monitor";
import { Logger } from 'winston';
import { Environment } from "../../application";
import * as bs58 from "bs58";

import {
  CHAIN_ID_BSC,
  CHAIN_ID_CELO,
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_SOLANA,
  ChainId,
  coalesceChainName,
  isEVMChain,
} from "@certusone/wormhole-sdk";

import {
  CHAIN_ID_AVAX,
  CHAIN_ID_FANTOM,
  CHAIN_ID_POLYGON,
  CHAIN_ID_SUI,
} from "@certusone/wormhole-sdk/lib/cjs/utils/consts";

const networks = {
  [Environment.MAINNET]: {
    [CHAIN_ID_ETH]: "mainnet",
    [CHAIN_ID_SOLANA]: "mainnet-beta",
    [CHAIN_ID_AVAX]: "mainnet",
    [CHAIN_ID_CELO]: "mainnet",
    [CHAIN_ID_BSC]: "mainnet",
    [CHAIN_ID_POLYGON]: "mainnet",
    [CHAIN_ID_FANTOM]: "mainnet",
    [CHAIN_ID_MOONBEAM]: "moonbeam-mainnet",
    [CHAIN_ID_SUI]: 'mainnet',
  },
  [Environment.TESTNET]: {
    [CHAIN_ID_ETH]: "goerli",
    [CHAIN_ID_SOLANA]: "devnet",
    [CHAIN_ID_AVAX]: "testnet",
    [CHAIN_ID_CELO]: "alfajores",
    [CHAIN_ID_BSC]: "testnet",
    [CHAIN_ID_POLYGON]: "mumbai",
    [CHAIN_ID_FANTOM]: "testnet",
    [CHAIN_ID_MOONBEAM]: "moonbase-alpha",
    [CHAIN_ID_SUI]: 'testnet'
  },
  [Environment.DEVNET]: {
    [CHAIN_ID_ETH]: "devnet",
    [CHAIN_ID_SOLANA]: "devnet",
    [CHAIN_ID_AVAX]: "devnet",
    [CHAIN_ID_CELO]: "devnet",
    [CHAIN_ID_BSC]: "devnet",
    [CHAIN_ID_POLYGON]: "devnet",
    [CHAIN_ID_FANTOM]: "devnet",
    [CHAIN_ID_MOONBEAM]: "devnet",
    [CHAIN_ID_SUI]: 'devnet',
  },
};

export type PrivateKeys = Partial<{ [k in ChainId]: string[] }>;

function buildWalletsConfig(
  env: Environment,
  privateKeys: PrivateKeys,
): WalletManagerConfig {
  const networkByChain: any = networks[env];
  const config: WalletManagerConfig = {};
  for (const [chainIdStr, keys] of Object.entries(privateKeys)) {
    const chainId = Number(chainIdStr) as ChainId;
    const chainName = coalesceChainName(chainId);

    const chainWallets = [];
    if (isEVMChain(chainId)) {
      for (const key of keys) {
        chainWallets.push({
          privateKey: key,
        });
      }
    } else if (CHAIN_ID_SOLANA === chainId) {
      for (const key of keys) {
        let secretKey;
        try {
          secretKey = new Uint8Array(JSON.parse(key));
        } catch (e) {
          secretKey = bs58.decode(key);
        }

        console.log({ solanaSecretKey: secretKey.toString() });

        chainWallets.push({
          privateKey: secretKey.toString(),
        });
      }
    }

    else if (chainId === CHAIN_ID_SUI) {
      for (const key of keys) {
        chainWallets.push({
          privateKey: key,
        });
      }
    }

    config[chainName] = { wallets: chainWallets, network: networkByChain[chainId] };
  }
  return config;
}

export function startWalletManagement(
  env: Environment,
  privateKeys: PrivateKeys,
  metricsOpts: WalletManagerOptions["metrics"],
  logger?: Logger,
) {
  const wallets = buildWalletsConfig(env, privateKeys);

  const manager = new WalletManager(wallets, {
    logger: logger ?? logger.child({ module: "wallet-manager" }),
    logLevel: 'error',
    metrics: metricsOpts,
  });

  return manager;
}
