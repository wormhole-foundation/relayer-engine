import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import {
  CHAIN_ID_ACALA,
  CHAIN_ID_ALGORAND,
  CHAIN_ID_APTOS,
  CHAIN_ID_BSC,
  CHAIN_ID_CELO,
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_SOLANA,
  ChainId,
  EVMChainId,
  isEVMChain,
} from "@certusone/wormhole-sdk";
import { ethers } from "ethers";
import { Connection } from "@solana/web3.js";
import { Environment } from "../application";
import {
  CHAIN_ID_AVAX,
  CHAIN_ID_FANTOM,
  CHAIN_ID_POLYGON,
} from "@certusone/wormhole-sdk/lib/cjs/utils/consts";

export interface Providers {
  evm: Partial<Record<EVMChainId, ethers.providers.JsonRpcProvider[]>>;
  solana: Connection[];
  untyped: Partial<Record<ChainId, UntypedProvider[]>>;
}

export type UntypedProvider = {
  rpcUrl: string;
};

export interface ProviderContext extends Context {
  providers: Providers;
}

export type ChainConfigInfo = {
  [k in ChainId]: { endpoints: string[] };
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
    [CHAIN_ID_APTOS]: {
      endpoints: ["https://fullnode.mainnet.aptoslabs.com/v1"],
    },
  },
  [Environment.TESTNET]: {
    [CHAIN_ID_ALGORAND]: { endpoints: ["node.testnet.algoexplorerapi.io/"] },
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

/**
 * providers is a middleware that populates `ctx.providers` with provider information
 * @param opts
 */
export function providers(opts?: ProvidersOpts): Middleware<ProviderContext> {
  let providers: Providers;

  return async (ctx: ProviderContext, next) => {
    if (!providers) {
      ctx.logger?.debug(`Providers initializing...`);
      providers = buildProviders(ctx.env, opts);
      ctx.logger?.debug(`Providers Initialized`);
    }
    ctx.providers = providers;
    ctx.logger?.debug("Providers attached to context");
    await next();
  };
}

function buildProviders(env: Environment, opts?: ProvidersOpts): Providers {
  const supportedChains = Object.assign(
    {},
    defaultSupportedChains[env],
    opts?.chains
  );
  const providers: Providers = {
    evm: {},
    solana: [],
    untyped: {},
  };
  for (const [chainIdStr, chainCfg] of Object.entries(supportedChains)) {
    const chainId = Number(chainIdStr) as ChainId;
    const { endpoints } = chainCfg;
    if (isEVMChain(chainId)) {
      providers.evm[chainId] = endpoints.map(
        (url) => new ethers.providers.JsonRpcProvider(url)
      );
    } else if (chainId === CHAIN_ID_SOLANA) {
      providers.solana = endpoints.map((url) => new Connection(url));
    } else {
      providers.untyped[chainId] = endpoints.map((c) => ({ rpcUrl: c }));
    }
  }
  return providers;
}
