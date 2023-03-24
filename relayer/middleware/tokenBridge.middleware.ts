import { Middleware } from "../compose.middleware";
import {
  CHAIN_ID_TO_NAME,
  ChainId,
  ChainName,
  CONTRACTS,
  EVMChainId,
  ParsedTokenTransferVaa,
  ParsedVaa,
  parseTokenTransferVaa,
} from "@certusone/wormhole-sdk";
import { ethers, Signer } from "ethers";
import { ProviderContext } from "./providers.middleware";
import { UnrecoverableError } from "bullmq";
import {
  ITokenBridge,
  ITokenBridge__factory,
} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts";
import { Environment } from "../application";
import { encodeEmitterAddress } from "../utils";

function extractTokenBridgeAddressesFromSdk(env: Environment) {
  return Object.fromEntries(
    Object.entries((CONTRACTS as any)[env.toUpperCase()]).map(
      ([chainName, addresses]: any[]) => [chainName, addresses.token_bridge]
    )
  );
}

const tokenBridgeAddresses = {
  [Environment.MAINNET]: extractTokenBridgeAddressesFromSdk(
    Environment.MAINNET
  ),
  [Environment.TESTNET]: extractTokenBridgeAddressesFromSdk(
    Environment.TESTNET
  ),
  [Environment.DEVNET]: extractTokenBridgeAddressesFromSdk(Environment.DEVNET),
};

export interface TokenBridgeContext extends ProviderContext {
  tokenBridge: {
    addresses: {
      [k in ChainName]?: string;
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
    vaa?: ParsedTokenTransferVaa;
  };
}

export type TokenBridgeChainConfigInfo = {
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
    const address = tokenBridgeAddresses[env][CHAIN_ID_TO_NAME[chainId]];
    const contracts = chainRpc.map((rpc) =>
      ITokenBridge__factory.connect(address, rpc)
    );
    evmChainContracts[chainId] = contracts;
  }
  return evmChainContracts;
}

function isTokenBridgeVaa(env: Environment, vaa: ParsedVaa): boolean {
  let chainId = vaa.emitterChain as ChainId;
  const chainName = CHAIN_ID_TO_NAME[chainId];

  // @ts-ignore TODO remove
  let tokenBridgeLocalAddress = tokenBridgeAddresses[env][chainName];
  if (!tokenBridgeLocalAddress) {
    return false;
  }

  const emitterAddress = vaa.emitterAddress.toString("hex");
  let tokenBridgeEmitterAddress = encodeEmitterAddress(
    chainId,
    tokenBridgeLocalAddress
  );
  return tokenBridgeEmitterAddress === emitterAddress;
}

export function tokenBridgeContracts(): Middleware<TokenBridgeContext> {
  let evmContracts: Partial<{[k in EVMChainId]: ITokenBridge[]}>;
  return async (ctx: TokenBridgeContext, next) => {
    if (!ctx.providers) {
      throw new UnrecoverableError(
        "You need to first use the providers middleware."
      );
    }
    if (!evmContracts) {
      ctx.logger?.debug(`Token Bridge Contracts initializing...`);
      evmContracts = instantiateReadEvmContracts(
        ctx.env,
        ctx.providers.evm
      );
      ctx.logger?.debug(`Token Bridge Contracts initialized`);
    }
    ctx.tokenBridge = {
      addresses: tokenBridgeAddresses[ctx.env],
      contractConstructor: ITokenBridge__factory.connect,
      contracts: {
        read: {
          evm: evmContracts,
        },
      },
      vaa: isTokenBridgeVaa(ctx.env, ctx.vaa)
        ? parseTokenTransferVaa(ctx.vaaBytes)
        : null,
    };
    await next();
  };
}
