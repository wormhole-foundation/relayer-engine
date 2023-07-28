import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import {
  CHAIN_ID_ACALA,
  CHAIN_ID_ALGORAND,
  CHAIN_ID_APTOS,
  CHAIN_ID_BASE,
  CHAIN_ID_BSC,
  CHAIN_ID_CELO,
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_SEI,
  CHAIN_ID_SOLANA,
  CHAIN_ID_SUI,
  ChainId,
  CHAINS,
  EVMChainId,
  EVMChainNames,
} from "@certusone/wormhole-sdk";
import { ethers } from "ethers";
import * as solana from "@solana/web3.js";
import {
  CHAIN_ID_ARBITRUM,
  CHAIN_ID_AVAX,
  CHAIN_ID_FANTOM,
  CHAIN_ID_KLAYTN,
  CHAIN_ID_OPTIMISM,
  CHAIN_ID_POLYGON,
} from "@certusone/wormhole-sdk/lib/cjs/utils/consts";
import * as sui from "@mysten/sui.js";
import { Environment } from "../environment";
import { getCosmWasmClient } from "@sei-js/core";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { Logger } from "winston";

export interface Providers {
  evm: Partial<Record<EVMChainId, ethers.providers.JsonRpcProvider[]>>;
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
  [k in ChainId]: {
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
    [CHAIN_ID_SOLANA]: { endpoints: ["https://api.mainnet-beta.solana.com"] },
    [CHAIN_ID_ETH]: { endpoints: ["https://rpc.ankr.com/eth"] },
    [CHAIN_ID_BSC]: { endpoints: ["https://bsc-dataseed1.binance.org/"] },
    [CHAIN_ID_POLYGON]: { endpoints: ["https://rpc.ankr.com/polygon"] },
    [CHAIN_ID_AVAX]: { endpoints: ["https://api.avax.network/ext/bc/C/rpc"] },
    [CHAIN_ID_FANTOM]: { endpoints: ["https://rpc.ftm.tools"] },
    [CHAIN_ID_CELO]: { endpoints: ["https://forno.celo.org"] },
    [CHAIN_ID_MOONBEAM]: { endpoints: ["https://rpc.api.moonbeam.network"] },
    [CHAIN_ID_ACALA]: { endpoints: ["https://eth-rpc-acala.aca-api.network"] },
    [CHAIN_ID_ALGORAND]: { endpoints: ["https://node.algoexplorerapi.io/"] },
    [CHAIN_ID_ARBITRUM]: {
      endpoints: [
        "https://arbitrum-one.publicnode.com",
        "https://rpc.ankr.com/arbitrum",
      ],
    },
    [CHAIN_ID_APTOS]: {
      endpoints: ["https://fullnode.mainnet.aptoslabs.com/v1"],
    },
    [CHAIN_ID_SUI]: {
      endpoints: ["https://rpc.mainnet.sui.io:443"],
      faucets: [""],
      websockets: [""],
    },
    [CHAIN_ID_KLAYTN]: {
      endpoints: ["https://public-node-api.klaytnapi.com/v1/cypress"],
    },
    [CHAIN_ID_OPTIMISM]: {
      endpoints: ["https://optimism.api.onfinality.io/public"],
    },
    [CHAIN_ID_BASE]: {
      endpoints: ["https://developer-access-mainnet.base.org"],
    },
  },
  [Environment.TESTNET]: {
    // [CHAIN_ID_ALGORAND]: { endpoints: ["node.testnet.algoexplorerapi.io/"] },
    [CHAIN_ID_SOLANA]: {
      endpoints: ["https://api.devnet.solana.com"],
    },
    [CHAIN_ID_ETH]: {
      endpoints: [
        "https://eth-goerli.g.alchemy.com/v2/mvFFcUhFfHujAOewWU8kH5D1R2bgFgLt",
      ],
    },
    [CHAIN_ID_BSC]: {
      endpoints: ["https://data-seed-prebsc-1-s3.binance.org:8545"],
    },
    [CHAIN_ID_POLYGON]: {
      endpoints: ["https://matic-mumbai.chainstacklabs.com"],
    },
    [CHAIN_ID_AVAX]: {
      endpoints: ["https://api.avax-test.network/ext/bc/C/rpc"],
    },
    [CHAIN_ID_FANTOM]: { endpoints: ["https://rpc.ankr.com/fantom_testnet"] },
    [CHAIN_ID_CELO]: {
      endpoints: ["https://alfajores-forno.celo-testnet.org"],
    },
    [CHAIN_ID_MOONBEAM]: {
      endpoints: ["https://rpc.testnet.moonbeam.network"],
    },
    [CHAIN_ID_APTOS]: {
      endpoints: ["https://fullnode.devnet.aptoslabs.com/v1"],
    },
    [CHAIN_ID_SUI]: {
      endpoints: [sui.testnetConnection.fullnode],
      faucets: [sui.testnetConnection.faucet],
      websockets: [sui.testnetConnection.websocket],
    },
    [CHAIN_ID_SEI]: {
      endpoints: ["https://sei-testnet-2-rpc.brocha.in"],
    },
    [CHAIN_ID_KLAYTN]: {
      endpoints: ["https://public-en-cypress.klaytn.net"],
    },
    [CHAIN_ID_OPTIMISM]: {
      endpoints: ["https://goerli.optimism.io"],
    },
    [CHAIN_ID_ARBITRUM]: {
      endpoints: [
        "https://arbitrum-goerli.public.blastapi.io",
        "https://arbitrum-goerli.publicnode.com",
      ],
    },
    [CHAIN_ID_BASE]: {
      endpoints: ["https://goerli.base.org"],
    },
  },
  [Environment.DEVNET]: {
    [CHAIN_ID_ETH]: {
      endpoints: ["http://localhost:8545/"],
    },
    [CHAIN_ID_BSC]: {
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

      logger?.debug(`Providers initializing... ${JSON.stringify(chains)}`);
      providers = await buildProviders(chains, logger);
      logger?.debug(`Providers initialized succesfully.`);
    }

    ctx.providers = providers;

    await next();
  };
}

const evmChainIds = EVMChainNames.map(n => CHAINS[n]);
const isEvmChainId = Object.fromEntries(evmChainIds.map(id => [id, true]));
const isEVMChain = (chainId: ChainId) => isEvmChainId[chainId] ?? false;

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
  for (const [chainIdStr, chainCfg] of Object.entries(supportedChains)) {
    const chainId = Number(chainIdStr) as ChainId;
    const { endpoints, faucets, websockets } = chainCfg;

    try {
      if (isEVMChain(chainId)) {
        providers.evm[chainId] = endpoints.map(
          url => new ethers.providers.JsonRpcProvider(url),
        );
      } else if (chainId === CHAIN_ID_SOLANA) {
        providers.solana = endpoints.map(url => new solana.Connection(url));
      } else if (chainId === CHAIN_ID_SUI) {
        providers.sui = endpoints.map((url, i) => {
          let conn = new sui.Connection({
            fullnode: url,
            faucet: (faucets && faucets[i]) || faucets[0], // try to map to the same index, otherwise use the first (if user only provided one faucet but multiple endpoints)
            websocket: (websockets && websockets[i]) || websockets[0], // same as above
          });
          return new sui.JsonRpcProvider(conn);
        });
      } else if (chainId === CHAIN_ID_SEI) {
        const seiProviderPromises = endpoints.map(url =>
          getCosmWasmClient(url),
        );
        providers.sei = await Promise.all(seiProviderPromises);
      } else {
        providers.untyped[chainId] = endpoints.map(c => ({ rpcUrl: c }));
      }
    } catch (error) {
      error.originalStack = error.stack;
      error.stack = new Error().stack;
      logger?.error(
        `Failed to initialize provider for chain: ${chainIdStr} - endpoints: ${endpoints}. Error: `,
        error,
      );
      throw error;
    }
  }

  return providers;
}
