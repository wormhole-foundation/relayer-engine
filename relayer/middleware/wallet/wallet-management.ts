import {
  buildWalletManager,
  WalletManagerFullConfig,
} from "@xlabs-xyz/wallet-monitor";
import { Logger } from "winston";
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
  CHAIN_ID_BASE,
  CHAIN_ID_FANTOM,
  CHAIN_ID_POLYGON,
  CHAIN_ID_SEI,
  CHAIN_ID_SUI,
} from "@certusone/wormhole-sdk/lib/cjs/utils/consts";
import { Environment } from "../../environment";

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
    [CHAIN_ID_SUI]: "mainnet",
    [CHAIN_ID_BASE]: "mainnet",
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
    [CHAIN_ID_SUI]: "testnet",
    [CHAIN_ID_BASE]: "goerli",
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
    [CHAIN_ID_SUI]: "devnet",
  },
};

export type PrivateKeys = Partial<{ [k in ChainId]: string[] }>;
export type TokensByChain = Partial<{ [k in ChainId]: string[] }>;

function buildWalletsConfig(
  env: Environment,
  privateKeys: PrivateKeys,
  tokensByChain?: TokensByChain,
): WalletManagerFullConfig["config"] {
  const networkByChain: any = networks[env];
  const config: WalletManagerFullConfig["config"] = {};
  const tokens = tokensByChain ?? {};
  for (const [chainIdStr, keys] of Object.entries(privateKeys)) {
    const chainId = Number(chainIdStr) as ChainId;
    const chainName = coalesceChainName(chainId);

    const chainWallets = [];
    if (isEVMChain(chainId)) {
      for (const key of keys) {
        chainWallets.push({
          privateKey: key,
          tokens: tokens[chainId] ?? [],
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

        chainWallets.push({
          privateKey: secretKey.toString(),
          tokens: tokens[chainId] ?? [],
        });
      }
    } else if (chainId === CHAIN_ID_SUI) {
      for (const key of keys) {
        chainWallets.push({
          privateKey: key,
          tokens: tokens[chainId] ?? [],
        });
      }
    } else if (chainId === CHAIN_ID_SEI) {
      continue;
      // The continue should be removed and the below section uncommented once wallet-monitor has been implemented for Sei
      // for (const key of keys) {
      //   chainWallets.push({
      //     privateKey: key,
      //   });
      // }
    }

    config[chainName] = {
      wallets: chainWallets,
      network: networkByChain[chainId],
    };
  }
  return config;
}

export function startWalletManagement(
  env: Environment,
  privateKeys: PrivateKeys,
  tokensByChain?: TokensByChain,
  metricsOpts?: WalletManagerFullConfig["options"]["metrics"],
  logger?: Logger,
) {
  const wallets = buildWalletsConfig(env, privateKeys, tokensByChain);

  const manager = buildWalletManager({
    config: wallets,
    options: {
      failOnInvalidChain: false,
      logger: logger?.child({ module: "wallet-manager" }),
      logLevel: "error",
      metrics: metricsOpts,
    },
  });

  return manager;
}
