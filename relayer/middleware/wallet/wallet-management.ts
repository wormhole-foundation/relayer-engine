import { ChainId, chainToPlatform, toChain } from "@wormhole-foundation/sdk";
import {
  buildWalletManager,
  IClientWalletManager,
  ILibraryWalletManager,
  WalletManagerFullConfig,
} from "@xlabs-xyz/wallet-monitor";
import { ethers } from "ethers";
import { Logger } from "winston";
import { Environment } from "../../environment.js";

export type MetricsOptions =
  (WalletManagerFullConfig["options"] & {})["metrics"] & {};

const networks = {
  [Environment.MAINNET]: {
    ["Ethereum"]: "mainnet",
    ["Solana"]: "mainnet-beta",
    ["Avalanche"]: "mainnet",
    ["Celo"]: "mainnet",
    ["Bsc"]: "mainnet",
    ["Polygon"]: "mainnet",
    ["Fantom"]: "mainnet",
    ["Moonbeam"]: "moonbeam-mainnet",
    ["Sui"]: "mainnet",
    ["Base"]: "mainnet",
    ["Arbitrum"]: "Arbitrum",
  },
  [Environment.TESTNET]: {
    ["Ethereum"]: "goerli",
    ["Solana"]: "solana-devnet",
    ["Avalanche"]: "testnet",
    ["Celo"]: "alfajores",
    ["Bsc"]: "testnet",
    ["Polygon"]: "mumbai",
    ["Fantom"]: "testnet",
    ["Moonbeam"]: "moonbase-alpha",
    ["Sui"]: "testnet",
    ["Base"]: "goerli",
    ["Arbitrum"]: "Arbitrum Testnet",
    ["Optimism"]: "goerli",
  },
  [Environment.DEVNET]: {
    ["Ethereum"]: "devnet",
    ["Solana"]: "devnet",
    ["Avalanche"]: "devnet",
    ["Celo"]: "devnet",
    ["Bsc"]: "devnet",
    ["Polygon"]: "devnet",
    ["Fantom"]: "devnet",
    ["Moonbeam"]: "devnet",
    ["Sui"]: "devnet",
    ["Arbitrum"]: "devnet",
    ["Optimism"]: "devnet",
    ["Base"]: "devnet",
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
    const chainName = toChain(chainId);

    const chainWallets = [];
    if (chainToPlatform(chainName) === "Evm") {
      for (const key of keys) {
        chainWallets.push({
          privateKey: key,
          tokens: tokens[chainId] ?? [],
        });
      }
    } else if (chainName === "Solana") {
      for (const key of keys) {
        let secretKey;
        try {
          secretKey = new Uint8Array(JSON.parse(key));
        } catch (e) {
          secretKey = ethers.utils.base58.decode(key);
        }

        chainWallets.push({
          privateKey: secretKey.toString(),
          tokens: tokens[chainId] ?? [],
        });
      }
    } else if (chainName === "Sui") {
      for (const key of keys) {
        chainWallets.push({
          privateKey: key,
          tokens: tokens[chainId] ?? [],
        });
      }
    } else if (chainName === "Sei") {
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
  metricsOpts?: MetricsOptions,
  logger?: Logger,
): IClientWalletManager | ILibraryWalletManager {
  const wallets = buildWalletsConfig(env, privateKeys, tokensByChain);

  const manager = buildWalletManager({
    config: wallets,
    options: {
      failOnInvalidChain: false,
      failOnInvalidTokens: false,
      logger: logger?.child({ module: "wallet-manager" }),
      logLevel: "error",
      metrics: metricsOpts,
    },
  });

  return manager;
}
