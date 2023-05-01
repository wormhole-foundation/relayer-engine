import { Middleware } from "../compose.middleware";
import {
  CHAIN_ID_TO_NAME,
  CHAIN_ID_SUI,
  ChainId,
  ChainName,
  coalesceChainName,
  CONTRACTS,
  EVMChainId,
  ParsedTokenTransferVaa,
  ParsedVaa,
  parseTokenTransferVaa,
  SignedVaa,
  TokenTransfer,
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
import { JsonRpcProvider } from "@mysten/sui.js";
import { getObjectFields } from "@certusone/wormhole-sdk/lib/cjs/sui";

function extractTokenBridgeAddressesFromSdk(env: Environment) {
  return Object.fromEntries(
    Object.entries((CONTRACTS as any)[env.toUpperCase()]).map(
      ([chainName, addresses]: any[]) => [chainName, addresses.token_bridge],
    ),
  );
}

const tokenBridgeAddresses = {
  [Environment.MAINNET]: extractTokenBridgeAddressesFromSdk(
    Environment.MAINNET,
  ),
  [Environment.TESTNET]: extractTokenBridgeAddressesFromSdk(
    Environment.TESTNET,
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
      signerOrProvider: Signer | ethers.providers.Provider,
    ) => ITokenBridge;
    contracts: {
      read: {
        evm: {
          [k in EVMChainId]?: ITokenBridge[];
        };
      };
    };
    vaa?: ParsedTokenTransferVaa;
    payload?: TokenTransfer;
  };
}

export type TokenBridgeChainConfigInfo = {
  evm: {
    [k in EVMChainId]: { contracts: ITokenBridge[] };
  };
};

function instantiateReadEvmContracts(
  env: Environment,
  chainRpcs: Partial<Record<EVMChainId, ethers.providers.JsonRpcProvider[]>>,
) {
  const evmChainContracts: Partial<{
    [k in EVMChainId]: ITokenBridge[];
  }> = {};
  for (const [chainIdStr, chainRpc] of Object.entries(chainRpcs)) {
    const chainId = Number(chainIdStr) as EVMChainId;
    // @ts-ignore
    const address = tokenBridgeAddresses[env][CHAIN_ID_TO_NAME[chainId]];
    const contracts = chainRpc.map(rpc =>
      ITokenBridge__factory.connect(address, rpc),
    );
    evmChainContracts[chainId] = contracts;
  }
  return evmChainContracts;
}

// initialized when then first vaa comes through
let tokenBridgeEmitterCapSui = "";

function isTokenBridgeVaa(env: Environment, vaa: ParsedVaa): boolean {
  let chainId = vaa.emitterChain as ChainId;
  const chainName = coalesceChainName(chainId);

  // @ts-ignore TODO remove
  let tokenBridgeLocalAddress =
    vaa.emitterChain === CHAIN_ID_SUI
      ? tokenBridgeEmitterCapSui
      : tokenBridgeAddresses[env][chainName];
  if (!tokenBridgeLocalAddress) {
    return false;
  }

  const emitterAddress = vaa.emitterAddress.toString("hex");
  let tokenBridgeEmitterAddress = encodeEmitterAddress(
    chainId,
    tokenBridgeLocalAddress,
  );
  return tokenBridgeEmitterAddress === emitterAddress;
}

function tryToParseTokenTransferVaa(
  vaaBytes: SignedVaa,
): ParsedTokenTransferVaa | null {
  try {
    return parseTokenTransferVaa(vaaBytes);
  } catch (e) {
    // it may not be a token transfer vaa. TODO Maybe we want to do something to support attestations etc.
    return null;
  }
}

export function tokenBridgeContracts(): Middleware<TokenBridgeContext> {
  let evmContracts: Partial<{ [k in EVMChainId]: ITokenBridge[] }>;
  // Sui State
  let suiState: Record<any, any>;

  return async (ctx: TokenBridgeContext, next) => {
    if (!ctx.providers) {
      throw new UnrecoverableError(
        "You need to first use the providers middleware.",
      );
    }
    if (!suiState) {
      suiState = await getObjectFields(
        ctx.providers.sui[0],
        CONTRACTS[ctx.env.toUpperCase() as "MAINNET"].sui.token_bridge,
      );
      tokenBridgeEmitterCapSui = suiState.emitter_cap.fields.id.id;
    }
    if (!evmContracts) {
      ctx.logger?.debug(`Token Bridge Contracts initializing...`);
      evmContracts = instantiateReadEvmContracts(ctx.env, ctx.providers.evm);
      ctx.logger?.debug(`Token Bridge Contracts initialized`);
    }
    let parsedTokenTransferVaa = null;
    let payload = null;
    if (isTokenBridgeVaa(ctx.env, ctx.vaa)) {
      parsedTokenTransferVaa = tryToParseTokenTransferVaa(ctx.vaaBytes);
      if (parsedTokenTransferVaa) {
        payload = {
          payloadType: parsedTokenTransferVaa.payloadType,
          amount: parsedTokenTransferVaa.amount,
          tokenAddress: parsedTokenTransferVaa.tokenAddress,
          tokenChain: parsedTokenTransferVaa.tokenChain,
          to: parsedTokenTransferVaa.to,
          toChain: parsedTokenTransferVaa.toChain,
          fee: parsedTokenTransferVaa.fee,
          fromAddress: parsedTokenTransferVaa.fromAddress,
          tokenTransferPayload: parsedTokenTransferVaa.tokenTransferPayload,
        };
      }
    }

    ctx.tokenBridge = {
      addresses: tokenBridgeAddresses[ctx.env],
      contractConstructor: ITokenBridge__factory.connect,
      contracts: {
        read: {
          evm: evmContracts,
        },
      },
      vaa: parsedTokenTransferVaa,
      payload: payload,
    };
    ctx.logger?.debug("Token Bridge contracts attached to context");
    await next();
  };
}
