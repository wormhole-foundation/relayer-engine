import { Middleware } from "../compose.middleware";
import {
  CHAIN_ID_BSC,
  CHAIN_ID_CELO,
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_SOLANA,
  ChainId,
  EVMChainId,
} from "@certusone/wormhole-sdk";
import { ethers, Signer } from "ethers";
import { Connection } from "@solana/web3.js";
import { ProviderContext } from "./providers.middleware";
import { UnrecoverableError } from "bullmq";
import {
  ITokenBridge,
  ITokenBridge__factory,
  TokenBridge,
  TokenBridge__factory,
} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";
import { Environment } from "../application";
import {
  CHAIN_ID_AVAX,
  CHAIN_ID_FANTOM,
  CHAIN_ID_POLYGON,
} from "@certusone/wormhole-sdk/lib/cjs/utils/consts";

const addresses = {
  [Environment.MAINNET]: {
    [CHAIN_ID_SOLANA]: "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
    [CHAIN_ID_ETH]: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
    [CHAIN_ID_BSC]: "0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7",
    [CHAIN_ID_POLYGON]: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE",
    [CHAIN_ID_AVAX]: "0x0e082F06FF657D94310cB8cE8B0D9a04541d8052",
    [CHAIN_ID_FANTOM]: "0x7C9Fc5741288cDFdD83CeB07f3ea7e22618D79D2",
    [CHAIN_ID_CELO]: "0x796Dff6D74F3E27060B71255Fe517BFb23C93eed",
    [CHAIN_ID_MOONBEAM]: "0xb1731c586ca89a23809861c6103f0b96b3f57d92",
  },
  [Environment.TESTNET]: {
    [CHAIN_ID_SOLANA]: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
    [CHAIN_ID_ETH]: "0xF890982f9310df57d00f659cf4fd87e65adEd8d7",
    [CHAIN_ID_BSC]: "0x9dcF9D205C9De35334D646BeE44b2D2859712A09",
    [CHAIN_ID_POLYGON]: "0x377D55a7928c046E18eEbb61977e714d2a76472a",
    [CHAIN_ID_AVAX]: "0x61E44E506Ca5659E6c0bba9b678586fA2d729756",
    [CHAIN_ID_FANTOM]: "0x599CEa2204B4FaECd584Ab1F2b6aCA137a0afbE8",
    [CHAIN_ID_CELO]: "0x05ca6037eC51F8b712eD2E6Fa72219FEaE74E153",
    [CHAIN_ID_MOONBEAM]: "0xb1731c586ca89a23809861c6103f0b96b3f57d92",
  },
  [Environment.DEVNET]: {},
};

export interface TokenBridgeContext extends ProviderContext {
  tokenBridge: {
    addresses: {
      [k in ChainId]?: string;
    };
    contractConstructor: (
      address: string,
      signerOrProvider: Signer | ethers.providers.Provider
    ) => ITokenBridge;
    contracts: {
      read: {
        evm: {
          [k in EVMChainId]?: ITokenBridge[];
        };
      };
    };
  };
}

export type ChainConfigInfo = {
  evm: {
    [k in EVMChainId]: { contracts: ITokenBridge[] };
  };
};

function instantiateReadEvmContracts(
  env: Environment,
  chainRpcs: Partial<Record<EVMChainId, ethers.providers.JsonRpcProvider[]>>
) {
  const evmChainContracts: Partial<{
    [k in EVMChainId]: ITokenBridge[];
  }> = {};
  for (const [chainIdStr, chainRpc] of Object.entries(chainRpcs)) {
    const chainId = Number(chainIdStr) as EVMChainId;
    // @ts-ignore
    const address = addresses[env][chainId];
    const contracts = chainRpc.map((rpc) =>
      ITokenBridge__factory.connect(address, rpc)
    );
    evmChainContracts[chainId] = contracts;
  }
  return evmChainContracts;
}

export function tokenBridgeContracts(): Middleware<TokenBridgeContext> {
  return async (ctx: TokenBridgeContext, next) => {
    if (!ctx.providers) {
      throw new UnrecoverableError(
        "You need to first use the providers middleware."
      );
    }
    const evmContracts = instantiateReadEvmContracts(
      ctx.env,
      ctx.providers.evm
    );
    ctx.tokenBridge = {
      addresses: addresses[ctx.env],
      contractConstructor: ITokenBridge__factory.connect,
      contracts: {
        read: {
          evm: evmContracts,
        },
      },
    };
    await next();
  };
}

const defaultProviders = {};
