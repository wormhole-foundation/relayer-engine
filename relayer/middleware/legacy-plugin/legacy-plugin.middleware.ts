import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { JsonRpcProvider } from "@mysten/sui.js";
import { Connection } from "@solana/web3.js";
import { ChainId, chainToPlatform, toChain } from "@wormhole-foundation/sdk";
import { RelayerApp } from "../../application.js";
import { StorageContext } from "../../storage/storage.js";
import { LoggingContext } from "../logger.middleware.js";
import { ProviderContext, Providers } from "../providers.middleware.js";
import { StagingAreaContext } from "../staging-area.middleware.js";
import {
  EVMWallet,
  SolanaWallet,
  Wallet,
  WalletContext,
  WalletToolBox,
} from "../wallet/index.js";
import * as legacy from "./legacy-plugin-definition.js";
import {
  Providers as LegacyProviders,
  Plugin,
} from "./legacy-plugin-definition.js";

export type PluginContext<Ext> = LoggingContext &
  StorageContext &
  StagingAreaContext &
  WalletContext &
  ProviderContext &
  Ext;

export function legacyPluginCompat<Ext>(
  app: RelayerApp<PluginContext<Ext>>,
  plugin: Plugin,
) {
  const filters = plugin.getFilters();
  const multiple = {} as Partial<{ [k in ChainId]: string[] }>;
  for (const { chainId, emitterAddress, doNotTransform } of filters) {
    if (multiple[chainId]?.length !== 0) {
      multiple[chainId] = [];
    }
    // todo: support doNotTransform option
    multiple[chainId]?.push(emitterAddress);
  }

  // plugin.afterSetup(providers, )

  app.multiple(multiple, async (ctx: PluginContext<Ext>, next) => {
    const { kv, vaa, vaaBytes, logger } = ctx;
    const vaaWithBytes = vaa;

    if (!vaaWithBytes) return next();

    vaaWithBytes.bytes = vaaBytes!;
    const providers = providersShimToLegacy(ctx.providers);

    const res = await plugin.consumeEvent(
      vaaWithBytes,
      kv,
      Object.assign(providers),
    );
    if (!res) {
      return next();
    }
    const { workflowOptions, workflowData } = res!;

    await plugin.handleWorkflow(
      { data: workflowData } as legacy.Workflow,
      providers,
      makeExecuteWrapper(ctx),
    );
    return next();
  });
}

function makeExecuteWrapper(ctx: PluginContext<any>): {
  <T, W extends legacy.Wallet>(action: legacy.Action<T, W>): Promise<any>;
  onEVM<T>(action: legacy.Action<T, EVMWallet>): Promise<T>;
  onSolana<T>(f: any): Promise<T>;
  onSui<T>(f: any): Promise<T>;
} {
  const execute = async <T, W extends legacy.Wallet>(
    action: legacy.Action<T, W>,
  ) => {
    const chain = toChain(action.chainId);
    if (chainToPlatform(chain) === "Evm") {
      ctx.wallets.onEVM(
        action.chainId,
        (wallet: WalletToolBox<any>, chainId: ChainId) => {
          // TODO: ben
          // @ts-ignore
          return action.f(walletShimToLegacy(wallet), chainId);
        },
      );
    } else if (toChain(action.chainId) === "Solana") {
      return ctx.wallets.onSolana((wallet: WalletToolBox<SolanaWallet>) =>
        (action.f as legacy.ActionFunc<T, SolanaWallet>)(
          walletShimToLegacy<SolanaWallet>(wallet),
          action.chainId,
        ),
      );
    }
  };
  execute.onEVM = <T>(
    action: legacy.Action<T, legacy.EVMWallet>,
  ): Promise<T> => {
    return ctx.wallets.onEVM(
      action.chainId,
      (wallet: WalletToolBox<EVMWallet>) =>
        action.f(walletShimToLegacy(wallet), action.chainId),
    );
  };
  execute.onSolana = <T>(f: any): Promise<T> => {
    return ctx.wallets.onSolana(f);
  };
  execute.onSui = <T>(f: any): Promise<T> => {
    return ctx.wallets.onSui(f);
  };
  return execute;
}

function providersShimToLegacy(providers: Providers): LegacyProviders {
  return {
    solana:
      providers.solana.length > 0
        ? providers.solana[0]
        : (undefined as unknown as Connection),
    untyped: Object.fromEntries(
      Object.entries(providers.untyped).map(([chain, rpcs]) => [
        chain,
        rpcs[0],
      ]),
    ),
    evm: Object.fromEntries(
      Object.entries(providers.evm).map(([chain, rpcs]) => [chain, rpcs[0]]),
    ),
    sui:
      providers.sui.length > 0
        ? providers.sui[0]
        : (undefined as unknown as JsonRpcProvider),
    sei:
      providers.sei.length > 0
        ? providers.sei[0]
        : (undefined as unknown as CosmWasmClient),
  };
}

function providersShimFromLegacy(providers: LegacyProviders): Providers {
  return {
    solana: providers.solana ? [providers.solana] : [],
    untyped: Object.fromEntries(
      Object.entries(providers.untyped).map(([chain, rpc]) => [chain, [rpc]]),
    ),
    evm: Object.fromEntries(
      Object.entries(providers.evm).map(([chain, rpc]) => [chain, [rpc]]),
    ),
    sui: providers.sui ? [providers.sui] : [],
    sei: providers.sei ? [providers.sei] : [],
  };
}

function walletShimToLegacy<T extends Wallet>(
  wallets: WalletToolBox<T>,
  // @ts-ignore
): legacy.WalletToolBox<T> {
  return {
    ...providersShimToLegacy(wallets),
    wallet: wallets.wallet,
  };
}

function walletShimFromLegacy<T extends legacy.Wallet>(
  wallets: legacy.WalletToolBox<T>,
): WalletToolBox<T> {
  return {
    ...providersShimFromLegacy(wallets),
    wallet: wallets.wallet,
    async getBalance(): Promise<string> {
      return "NOT IMPLEMENTED";
    },
    address: "NOT IMPLEMENTED",
  };
}
