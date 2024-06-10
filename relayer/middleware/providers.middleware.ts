import { ethers } from "ethers";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import * as sui from "@mysten/sui.js";
import { getCosmWasmClient } from "@sei-js/core";
import * as solana from "@solana/web3.js";
import {
  Chain,
  ChainId,
  chainToPlatform,
  platformToChains,
  toChainId,
} from "@wormhole-foundation/sdk";
import { EvmChain, EvmChains } from "@wormhole-foundation/sdk-evm";
import { Logger } from "winston";
import { Middleware } from "../compose.middleware.js";
import { Context } from "../context.js";
import { Environment } from "../environment.js";
import { printError } from "../utils.js";

export interface Providers {
  evm: Partial<Record<EvmChains, ethers.providers.JsonRpcProvider[]>>;
  solana: solana.Connection[];
  untyped: Partial<Record<ChainId, UntypedProvider[]>>;
  sui: sui.JsonRpcProvider[];
  sei: CosmWasmClient[];
}

export type UntypedProvider = {
  rpcUrl: string;
};

export interface ProviderContext extends Context {
  providers: Providers;
}

export type ChainConfigInfo = {
  [k in Chain]: {
    endpoints: string[];
    faucets?: string[];
    websockets?: string[];
  };
};

export interface ProvidersOpts {
  chains: Partial<ChainConfigInfo>;
}

const defaultSupportedChains = {
  [Environment.MAINNET]: {
    ["Solana"]: { endpoints: ["https://api.mainnet-beta.solana.com"] },
    ["Ethereum"]: { endpoints: ["https://rpc.ankr.com/eth"] },
    ["Bsc"]: { endpoints: ["https://bsc-dataseed1.binance.org/"] },
    ["Polygon"]: { endpoints: ["https://rpc.ankr.com/polygon"] },
    ["Avalanche"]: { endpoints: ["https://api.avax.network/ext/bc/C/rpc"] },
    ["Fantom"]: { endpoints: ["https://rpc.ftm.tools"] },
    ["Celo"]: { endpoints: ["https://forno.celo.org"] },
    ["Moonbeam"]: { endpoints: ["https://rpc.api.moonbeam.network"] },
    ["Acala"]: { endpoints: ["https://eth-rpc-acala.aca-api.network"] },
    ["Algorand"]: { endpoints: ["https://node.algoexplorerapi.io/"] },
    ["Arbitrum"]: {
      endpoints: [
        "https://arbitrum-one.publicnode.com",
        "https://rpc.ankr.com/arbitrum",
      ],
    },
    ["Aptos"]: {
      endpoints: ["https://fullnode.mainnet.aptoslabs.com/v1"],
    },
    ["Sui"]: {
      endpoints: ["https://rpc.mainnet.sui.io:443"],
      faucets: [""],
      websockets: [""],
    },
    ["Klaytn"]: {
      endpoints: ["https://public-node-api.klaytnapi.com/v1/cypress"],
    },
    ["Optimism"]: {
      endpoints: ["https://optimism.api.onfinality.io/public"],
    },
    ["Base"]: {
      endpoints: ["https://developer-access-mainnet.base.org"],
    },
  },
  [Environment.TESTNET]: {
    // [CHAIN_ID_ALGORAND]: { endpoints: ["node.testnet.algoexplorerapi.io/"] },
    ["Solana"]: {
      endpoints: ["https://api.devnet.solana.com"],
    },
    ["Ethereum"]: {
      endpoints: [
        "https://eth-goerli.g.alchemy.com/v2/mvFFcUhFfHujAOewWU8kH5D1R2bgFgLt",
      ],
    },
    ["Sepolia"]: {
      endpoints: [
        "https://eth-sepolia.g.alchemy.com/v2/mvFFcUhFfHujAOewWU8kH5D1R2bgFgLt",
      ],
    },
    ["Bsc"]: {
      endpoints: ["https://data-seed-prebsc-1-s3.binance.org:8545"],
    },
    ["Polygon"]: {
      endpoints: ["https://matic-mumbai.chainstacklabs.com"],
    },
    ["Avalanche"]: {
      endpoints: ["https://api.avax-test.network/ext/bc/C/rpc"],
    },
    ["Fantom"]: { endpoints: ["https://rpc.ankr.com/fantom_testnet"] },
    ["Celo"]: {
      endpoints: ["https://alfajores-forno.celo-testnet.org"],
    },
    ["Moonbeam"]: {
      endpoints: ["https://rpc.testnet.moonbeam.network"],
    },
    ["Aptos"]: {
      endpoints: ["https://fullnode.devnet.aptoslabs.com/v1"],
    },
    ["Sui"]: {
      endpoints: [sui.testnetConnection.fullnode],
      faucets: [sui.testnetConnection.faucet],
      websockets: [sui.testnetConnection.websocket],
    },
    ["Sei"]: {
      endpoints: ["https://sei-testnet-2-rpc.brocha.in"],
    },
    ["Klaytn"]: {
      endpoints: ["https://public-en-cypress.klaytn.net"],
    },
    ["Optimism"]: {
      endpoints: ["https://goerli.optimism.io"],
    },
    ["Arbitrum"]: {
      endpoints: [
        "https://arbitrum-goerli.public.blastapi.io",
        "https://arbitrum-goerli.publicnode.com",
      ],
    },
    ["Base"]: {
      endpoints: ["https://goerli.base.org"],
    },
  },
  [Environment.DEVNET]: {
    ["Ethereum"]: {
      endpoints: ["http://localhost:8545/"],
    },
    ["Bsc"]: {
      endpoints: ["http://localhost:8546/"],
    },
  },
};

function pick<T extends Object, Prop extends string | number | symbol>(
  obj: T,
  keys: Prop[],
): Pick<T, Prop & keyof T> {
  const res = {} as Pick<T, Prop & keyof T>;
  for (const key of keys) {
    if (key in obj) {
      // We need to assert that this is a key of T because `key in obj` does not provide this type guard
      const keyAsserted = key as Prop & keyof T;
      res[keyAsserted] = obj[keyAsserted];
    }
  }
  return res;
}

/**
 * providers is a middleware that populates `ctx.providers` with provider information
 * @param opts
 */
export function providers(
  opts?: ProvidersOpts,
  supportedChains?: string[],
): Middleware<ProviderContext> {
  let providers: Providers;

  return async (ctx: ProviderContext, next) => {
    const logger = ctx.logger?.child({ module: "providers" });

    if (!providers) {
      // it makes no sense to start providers for all default
      // chains, we should only start providers for the chains the relayer
      // will use.
      // The config is optional because of backwards compatibility
      // If no config is passed, we'll start providers for all default chains
      const environmentDefaultSupportedChains = defaultSupportedChains[ctx.env];

      const defaultChains = supportedChains
        ? pick(environmentDefaultSupportedChains, supportedChains as any)
        : environmentDefaultSupportedChains;

      const chains = Object.assign({}, defaultChains, opts?.chains);

      logger?.debug(
        `Providers initializing... ${JSON.stringify(maskRPCProviders(chains))}`,
      );
      providers = await buildProviders(chains, logger);
      logger?.debug(`Providers initialized succesfully.`);
    }

    ctx.providers = providers;

    await next();
  };
}

async function buildProviders(
  supportedChains: Partial<ChainConfigInfo>,
  logger?: Logger,
): Promise<Providers> {
  const providers: Providers = {
    evm: {},
    solana: [],
    sui: [],
    sei: [],
    untyped: {},
  };
  for (const [chainStr, chainCfg] of Object.entries(supportedChains)) {
    const chain = chainStr as Chain;
    const chainId = toChainId(chain);

    const { endpoints, faucets, websockets } = chainCfg;

    try {
      if (chainToPlatform(chain) === "Evm") {
        // TODO: ben
        // @ts-ignore
        providers.evm[chain] = endpoints.map(
          url => new ethers.providers.JsonRpcProvider(url),
        );
      } else if (chain === "Solana") {
        providers.solana = endpoints.map(url => new solana.Connection(url));
      } else if (chain === "Sui") {
        providers.sui = endpoints.map((url, i) => {
          let conn = new sui.Connection({
            fullnode: url,
            faucet: faucets?.at(i) || faucets?.at(0), // try to map to the same index, otherwise use the first (if user only provided one faucet but multiple endpoints)
            websocket: websockets?.at(i) || websockets?.at(0), // same as above
          });
          return new sui.JsonRpcProvider(conn);
        });
      } else if (chain === "Sei") {
        const seiProviderPromises = endpoints.map(url =>
          getCosmWasmClient(url),
        );
        providers.sei = await Promise.all(seiProviderPromises);
      } else {
        providers.untyped[chainId] = endpoints.map(c => ({ rpcUrl: c }));
      }
    } catch (error) {
      if (error instanceof Error) {
        (error as any).originalStack = error.stack;
        Error.captureStackTrace(error);
      }
      logger?.error(
        `Failed to initialize provider for chain: ${chain} - endpoints: ${maskRPCEndpoints(
          endpoints,
        )}. Error: ${printError(error)}`,
      );
      throw error;
    }
  }

  return providers;
}

function maskRPCEndpoints(endpoints: string[]) {
  return endpoints.map((url: string) => {
    const apiKeyPos = url.indexOf("apiKey");
    if (apiKeyPos > -1) {
      // Found API key in the RPC url, show only initial 3 chars and mask the rest
      return url.substring(0, apiKeyPos + 10) + "***";
    }
    return url;
  });
}

function maskRPCProviders(chains: Partial<ChainConfigInfo>) {
  const maskedChains: Partial<ChainConfigInfo> = {};
  for (const [chainStr, chainConfig] of Object.entries(chains)) {
    const chain = chainStr as Chain;
    maskedChains[chain] = {
      endpoints: maskRPCEndpoints(chainConfig.endpoints),
    };
  }
  return maskedChains;
}
