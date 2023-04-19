import {
  ChainId,
  CHAIN_ID_SOLANA,
  EVMChainId,
  isEVMChain,
} from "@certusone/wormhole-sdk";
import { ParsedVaaWithBytes, RelayerApp } from "../../application";
import {
  Plugin,
  Providers as LegacyProviders,
} from "./legacy-plugin-definition";
import * as legacy from "./legacy-plugin-definition";
import { StorageContext } from "../../storage/storage";
import { LoggingContext } from "../logger.middleware";
import { StagingAreaContext } from "../staging-area.middleware";
import { ProviderContext, Providers } from "../providers.middleware";
import { SolanaWallet, Wallet, WalletContext } from "../wallet";
import { EVMWallet, WalletToolBox } from "../wallet";
import { Connection } from "@solana/web3.js";

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
    const vaaWithBytes = vaa as ParsedVaaWithBytes;
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
  onEVM<T>(action: legacy.Action<T, Wallet>): Promise<T>;
  onSolana<T>(f: any): Promise<T>;
} {
  const execute = async <T, W extends legacy.Wallet>(
    action: legacy.Action<T, W>,
  ) => {
    if (isEVMChain(action.chainId)) {
      ctx.wallets.onEVM(
        action.chainId,
        (wallet: WalletToolBox<any>, chainId: ChainId) => {
          return action.f(walletShimToLegacy(wallet), chainId);
        },
      );
    } else if (action.chainId === CHAIN_ID_SOLANA) {
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
      action.chainId as EVMChainId,
      (wallet: WalletToolBox<EVMWallet>) =>
        action.f(walletShimToLegacy(wallet), action.chainId),
    );
  };
  execute.onSolana = <T>(f: any): Promise<T> => {
    return ctx.wallets.onSolana(f);
  };
  return execute;
}

function providersShimToLegacy(providers: Providers): LegacyProviders {
  return {
    solana:
      providers.solana.length > 0
        ? providers.solana[0]
        : (undefined as Connection),
    untyped: Object.fromEntries(
      Object.entries(providers.untyped).map(([chain, rpcs]) => [
        chain,
        rpcs[0],
      ]),
    ),
    evm: Object.fromEntries(
      Object.entries(providers.evm).map(([chain, rpcs]) => [chain, rpcs[0]]),
    ),
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
  };
}

function walletShimToLegacy<T extends Wallet>(
  wallets: WalletToolBox<T>,
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
  };
}
