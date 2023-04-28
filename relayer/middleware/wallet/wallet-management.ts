import { WalletManager, WalletManagerConfig, WalletManagerOptions } from "@xlabs-xyz/wallet-monitor";
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
} from "@certusone/wormhole-sdk/lib/cjs/utils/consts";

const networks = {
  [Environment.MAINNET]: {
    [CHAIN_ID_ETH]: "mainnet",
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
          privateKey: key
        });
      }
    }
    
    else if (CHAIN_ID_SOLANA === chainId) {
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

    config[chainName] = { wallets: chainWallets, network: networkByChain[chainId] };
  }
  return config;
}

export function startWalletManagement(
  env: Environment,
  privateKeys: PrivateKeys,
  metricsOpts: WalletManagerOptions['metrics']
) {
  const wallets = buildWalletsConfig(env, privateKeys);

  const manager = new WalletManager(wallets, {
    logLevel: 'debug',
    metrics: metricsOpts,
  });

  manager.withWallet('ethereum', async (wallet) => {
    console.log(wallet.provider);
  });
  
  return manager;
}