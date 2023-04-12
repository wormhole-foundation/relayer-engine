import * as bs58 from "bs58";
import { ethers } from "ethers";
import * as solana from "@solana/web3.js";
import {
  CHAIN_ID_BSC,
  CHAIN_ID_CELO,
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_SOLANA,
  CHAIN_ID_TO_NAME,
  ChainId,
  coalesceChainName,
  EVMChainId,
  isEVMChain,
} from "@certusone/wormhole-sdk";
import { WalletToolBox } from "./walletToolBox";
import { Middleware } from "../../compose.middleware";
import { spawnWalletWorker } from "./wallet.worker";
import { Queue } from "@datastructures-js/queue";
import { ProviderContext, UntypedProvider } from "../providers.middleware";
import { Logger } from "winston";
import { MultiWalletExporter } from "@xlabs-xyz/wallet-monitor";
import { Registry } from "prom-client";
import { MultiWalletWatcherConfig } from "@xlabs-xyz/wallet-monitor/lib/multi-wallet-watcher";
import { Environment } from "../../application";
import {
  CHAIN_ID_AVAX,
  CHAIN_ID_FANTOM,
  CHAIN_ID_POLYGON,
} from "@certusone/wormhole-sdk/lib/cjs/utils/consts";

export type EVMWallet = ethers.Wallet;

export type SolanaWallet = {
  conn: solana.Connection;
  payer: solana.Keypair;
};

export type Wallet = EVMWallet | SolanaWallet | UntypedWallet;

export type UntypedWallet = UntypedProvider & {
  privateKey: string;
};

export interface Action<T, W extends Wallet> {
  chainId: ChainId;
  f: ActionFunc<T, W>;
}

export type ActionFunc<T, W extends Wallet> = (
  walletToolBox: WalletToolBox<W>,
  chaidId: ChainId,
) => Promise<T>;

export interface ActionWithCont<T, W extends Wallet> {
  action: Action<T, W>;
  pluginName: string;
  resolve: (t: T) => void;
  reject: (reason: any) => void;
}

export interface WorkerInfo {
  id: number;
  targetChainId: ChainId;
  targetChainName: string;
  walletPrivateKey: string;
}

export interface ActionExecutor {
  <T, W extends Wallet>(chaindId: ChainId, f: ActionFunc<T, W>): Promise<T>;
  onSolana<T>(f: ActionFunc<T, SolanaWallet>): Promise<T>;
  onEVM<T>(chainId: EVMChainId, f: ActionFunc<T, EVMWallet>): Promise<T>;
}

function makeExecuteFunc(
  actionQueues: Map<ChainId, Queue<ActionWithCont<any, any>>>,
  pluginName: string,
  logger?: Logger,
): ActionExecutor {
  // push action onto actionQueue and have worker reject or resolve promise
  const func = <T, W extends Wallet>(
    chainId: ChainId,
    f: ActionFunc<T, W>,
  ): Promise<T> => {
    return new Promise((resolve, reject) => {
      const maybeQueue = actionQueues.get(chainId);
      if (!maybeQueue) {
        logger?.error(
          `Error making execute function. Unsupported chain: ${chainId}`,
        );
        return reject("Chain not supported");
      }
      maybeQueue.enqueue({
        action: { chainId, f },
        pluginName,
        resolve,
        reject,
      });
    });
  };
  func.onSolana = <T>(f: ActionFunc<T, SolanaWallet>) =>
    func(CHAIN_ID_SOLANA, f);
  func.onEVM = <T>(chainId: ChainId, f: ActionFunc<T, EVMWallet>) =>
    func(chainId, f);
  return func;
}

export interface WalletContext extends ProviderContext {
  wallets: ActionExecutor;
}

export interface WalletOpts {
  namespace: string;
  privateKeys: Partial<{
    [k in ChainId]: any[];
  }>;
  logger?: Logger;
  metrics?: {
    registry: Registry;
  };
}

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
  [Environment.DEVNET]: {},
};

function buildMonitoringFromPrivateKeys(
  env: Environment,
  privateKeys: Partial<{
    [k in ChainId]: any[];
  }>,
): MultiWalletWatcherConfig {
  const networkByChain: any = networks[env];
  const config: MultiWalletWatcherConfig = {};
  for (const [chainIdStr, keys] of Object.entries(privateKeys)) {
    const chainId = Number(chainIdStr) as ChainId;
    const chainName = coalesceChainName(chainId);
    let addresses: Record<string, string[]> = {};
    if (isEVMChain(chainId)) {
      for (const key of keys) {
        addresses[new ethers.Wallet(key).address] = [];
      }
    } else if (CHAIN_ID_SOLANA === chainId) {
      for (const key of keys) {
        let secretKey;
        try {
          secretKey = new Uint8Array(JSON.parse(key));
        } catch (e) {
          secretKey = bs58.decode(key);
        }
        addresses[
          solana.Keypair.fromSecretKey(secretKey).publicKey.toBase58()
        ] = [];
      }
    }
    config[chainName] = { addresses, network: networkByChain[chainId] };
  }
  return config;
}

export function wallets(
  env: Environment,
  opts: WalletOpts,
): Middleware<WalletContext> {
  const workerInfoMap = new Map<ChainId, WorkerInfo[]>(
    Object.entries(opts.privateKeys).map(([chainIdStr, keys]) => {
      //TODO update for all ecosystems
      let chainId = Number(chainIdStr) as ChainId;
      const workerInfos = keys.map((key, id) => ({
        id,
        targetChainId: chainId,
        targetChainName: CHAIN_ID_TO_NAME[chainId],
        walletPrivateKey: key,
      }));
      return [chainId, workerInfos];
    }),
  );

  const wallets = buildMonitoringFromPrivateKeys(env, opts.privateKeys);
  opts.logger?.info(JSON.stringify(wallets, null, 2));

  if (opts.metrics) {
    const exporter = new MultiWalletExporter(wallets, {
      logger: opts.logger,
      prometheus: { registry: opts.metrics.registry },
    });
    exporter.start();
  }

  let executeFunction: ActionExecutor;
  return async (ctx: WalletContext, next) => {
    if (!executeFunction) {
      ctx.logger?.debug(`Initializing wallets...`);
      const actionQueues = new Map<ChainId, Queue<ActionWithCont<any, any>>>();
      for (const [chain, workerInfos] of workerInfoMap.entries()) {
        const actionQueue = new Queue<ActionWithCont<any, any>>();
        actionQueues.set(chain, actionQueue);
        workerInfos.forEach(info =>
          spawnWalletWorker(actionQueue, ctx.providers, info, opts.logger),
        );
      }
      executeFunction = makeExecuteFunc(
        actionQueues,
        opts.namespace ?? "default",
        opts.logger,
      );
      ctx.logger?.debug(`Initialized wallets`);
    }

    ctx.logger?.debug("wallets attached to context");
    ctx.wallets = executeFunction;
    await next();
  };
}
