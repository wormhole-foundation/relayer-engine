import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import Redis, { Cluster, ClusterNode, RedisOptions } from "ioredis";
import {
  ChainId,
  getSignedVAAWithRetry,
  ParsedVaa,
  parseVaa,
  SignedVaa,
  solana,
} from "@certusone/wormhole-sdk";
import { defaultWormholeRpcs, Environment, RelayerApp } from "../application";
import { Logger } from "winston";
import { createPool, Pool } from "generic-pool";
import { sleep } from "../utils";
import {
  ParsedVaaWithBytes,
  Plugin,
  Providers as LegacyProviders,
  Workflow,
} from "../legacy-plugin-definition";
import { StorageContext } from "../storage";
import { LoggingContext } from "./logger.middleware";
import { StagingAreaContext } from "./staging-area.middleware";
import { ProviderContext, Providers } from "./providers.middleware";
import { WalletContext } from "./wallet/wallet.middleware";

export type PluginContext<Ext> = LoggingContext &
  StorageContext &
  StagingAreaContext &
  WalletContext &
  ProviderContext &
  Ext;

export function legacyPluginCompat<Ext>(
  app: RelayerApp<PluginContext<Ext>>,
  plugin: Plugin
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
    const providers: LegacyProviders = {
      untyped: {} as any,
      evm: Object.fromEntries(
        Object.entries(ctx.providers.evm).map(([chain, rpcs]) => [
          chain,
          rpcs[0],
        ])
      ),
      solana:
        ctx.providers.solana?.length > 0
          ? ctx.providers.solana[0]
          : (undefined as any),
    };
    const res = await plugin.consumeEvent(
      vaaWithBytes,
      kv,
      Object.assign(providers, { untyped: {} as any })
    );
    if (!res) {
      next();
    }
    const { workflowOptions, workflowData } = res!;
    await plugin.handleWorkflow(
      { data: workflowData } as Workflow,
      providers,
      ctx.wallets as any
    );
    next()
  });

  return async (ctx, next) => {};
}

export function parseVaaWithBytes(
  vaa: ParsedVaaWithBytes | SignedVaa | ParsedVaa
): ParsedVaaWithBytes {
  // @ts-ignore
  if (vaa?.emitterAddress?.length > 0) {
    return vaa as ParsedVaaWithBytes;
  }
  const parsedVaa = parseVaa(vaa as SignedVaa) as ParsedVaaWithBytes;
  parsedVaa.bytes = Buffer.from(vaa as SignedVaa);
  return parsedVaa;
}
