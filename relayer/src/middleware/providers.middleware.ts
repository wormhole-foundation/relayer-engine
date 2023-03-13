import { Logger } from "winston";
import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import {
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
}

export interface ProviderContext extends Context {
  providers: Providers;
}

export type ChainConfigInfo = {
  [k in ChainId]: { nodeUrls: string[] };
};

interface ProvidersOpts {
  supportedChains: ChainConfigInfo;
}

const defaultSupportedChains = {
  [Environment.MAINNET]: {
    [CHAIN_ID_SOLANA]: { nodeUrls: [""] },
    [CHAIN_ID_ETH]: { nodeUrls: ["https://rpc.ankr.com/eth"] },
    [CHAIN_ID_BSC]: { nodeUrls: ["https://bsc-dataseed1.binance.org/"] },
    [CHAIN_ID_POLYGON]: { nodeUrls: ["https://rpc.ankr.com/polygon"] },
    [CHAIN_ID_AVAX]: { nodeUrls: ["https://api.avax.network/ext/bc/C/rpc"] },
    [CHAIN_ID_FANTOM]: { nodeUrls: ["https://rpc.ftm.tools"] },
    [CHAIN_ID_CELO]: { nodeUrls: ["https://forno.celo.org"] },
    [CHAIN_ID_MOONBEAM]: { nodeUrls: ["https://rpc.api.moonbeam.network"] },
  },
  [Environment.TESTNET]: {
    [CHAIN_ID_ETH]: {
      nodeUrls: [
        "https://eth-goerli.g.alchemy.com/v2/mvFFcUhFfHujAOewWU8kH5D1R2bgFgLt",
      ],
    },
    [CHAIN_ID_BSC]: {
      nodeUrls: ["https://data-seed-prebsc-1-s3.binance.org:8545"],
    },
    [CHAIN_ID_POLYGON]: {
      nodeUrls: ["https://matic-mumbai.chainstacklabs.com"],
    },
    [CHAIN_ID_AVAX]: {
      nodeUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
    },
    [CHAIN_ID_FANTOM]: { nodeUrls: ["https://rpc.ankr.com/fantom_testnet"] },
    [CHAIN_ID_CELO]: { nodeUrls: ["https://alfajores-forno.celo-testnet.org"] },
    [CHAIN_ID_MOONBEAM]: { nodeUrls: ["https://rpc.testnet.moonbeam.network"] },
  },
  [Environment.DEVNET]: {},
};

function buildProviders(env: Environment, opts?: ProvidersOpts): Providers {
  const supportedChains = Object.assign(
    {},
    defaultSupportedChains[env],
    opts?.supportedChains
  );
  const providers: Providers = {
    evm: {},
    solana: [],
  };
  for (const [chainIdStr, chainCfg] of Object.entries(supportedChains)) {
    const chainId = Number(chainIdStr) as ChainId;
    const { nodeUrls } = chainCfg;
    if (isEVMChain(chainId)) {
      providers.evm[chainId] = nodeUrls.map(
        (url) => new ethers.providers.JsonRpcProvider(url)
      );
    } else if (chainId === CHAIN_ID_SOLANA) {
      providers.solana = nodeUrls.map((url) => new Connection(url));
    }
  }
  return providers;
}

export function providers(opts?: ProvidersOpts): Middleware<ProviderContext> {
  let providers: Providers;

  return async (ctx: ProviderContext, next) => {
    if (!providers) {
      providers = buildProviders(ctx.env, opts);
    }
    ctx.providers = providers;
    await next();
  };
}

const defaultProviders = {};
