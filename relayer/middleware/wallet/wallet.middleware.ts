import { ethers } from "ethers";
import * as solana from "@solana/web3.js";
import * as sui from "@mysten/sui.js";
import { WalletToolBox } from "./walletToolBox.js";
import { Middleware } from "../../compose.middleware.js";
import { spawnWalletWorker } from "./wallet.worker.js";
import { Queue } from "@datastructures-js/queue";
import { ProviderContext, UntypedProvider } from "../providers.middleware.js";
import { Logger } from "winston";
import { startWalletManagement, TokensByChain } from "./wallet-management.js";
import { Registry } from "prom-client";
import { Environment } from "../../environment.js";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import { ChainId, toChain, toChainId } from "@wormhole-foundation/sdk";

export type EVMWallet = ethers.Wallet;
export type SuiWallet = sui.RawSigner;
export type SeiWallet = DirectSecp256k1Wallet;

export type SolanaWallet = {
  conn: solana.Connection;
  payer: solana.Keypair;
};

export type Wallet =
  | EVMWallet
  | SolanaWallet
  | UntypedWallet
  | SuiWallet
  | SeiWallet;

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

  onEVM<T>(chainId: ChainId, f: ActionFunc<T, EVMWallet>): Promise<T>;

  onSei<T>(f: ActionFunc<T, SeiWallet>): Promise<T>;

  onSui<T>(f: ActionFunc<T, SuiWallet>): Promise<T>;
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
    func(toChainId("Solana"), f);
  func.onSui = <T>(f: ActionFunc<T, SuiWallet>) => func(toChainId("Sui"), f);
  func.onSei = <T>(f: ActionFunc<T, SeiWallet>) => func(toChainId("Sei"), f);
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
  tokensByChain?: TokensByChain;
  logger?: Logger;
  metrics?: {
    enabled: boolean;
    registry: Registry;
  };
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
        targetChainName: toChain(chainId),
        walletPrivateKey: key,
      }));
      return [chainId, workerInfos];
    }),
  );

  if (opts.metrics) {
    startWalletManagement(
      env,
      opts.privateKeys,
      opts.tokensByChain,
      opts.metrics,
      opts.logger,
    );
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
