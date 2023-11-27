import { Middleware } from "../compose.middleware.js";
import {
  CHAIN_ID_SUI,
  CHAIN_ID_TO_NAME,
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
import { ProviderContext } from "./providers.middleware.js";
import { UnrecoverableError } from "bullmq";
import {
  ITokenBridge,
  ITokenBridge__factory,
} from "@certusone/wormhole-sdk/lib/cjs/ethers-contracts/index.js";
import { encodeEmitterAddress } from "../utils.js";
import { getObjectFields } from "@certusone/wormhole-sdk/lib/cjs/sui/index.js";
import { Environment } from "../environment.js";

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
): ParsedTokenTransferVaa | undefined {
  try {
    return parseTokenTransferVaa(vaaBytes);
  } catch (e) {
    // it may not be a token transfer vaa. TODO Maybe we want to do something to support attestations etc.
    return undefined;
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
    // User might or might not use sui, so a provider for sui
    // might not be present.
    if (suiState === undefined && ctx.providers.sui.length > 0) {
      const fields = await getObjectFields(
        ctx.providers.sui[0],
        CONTRACTS[ctx.env.toUpperCase() as "MAINNET" | "TESTNET" | "DEVNET"].sui
          .token_bridge,
      );
      if (fields === null) {
        throw new UnrecoverableError("Couldn't read Sui object field");
      }
      suiState = fields;
      tokenBridgeEmitterCapSui = suiState?.emitter_cap.fields.id.id;
    }
    if (!evmContracts) {
      ctx.logger?.debug(`Token Bridge Contracts initializing...`);
      evmContracts = instantiateReadEvmContracts(ctx.env, ctx.providers.evm);
      ctx.logger?.debug(`Token Bridge Contracts initialized`);
    }

    // TODO: should we actually allow these fields to be undefined in the context type?
    if (ctx.vaa === undefined) {
      throw new UnrecoverableError("Parsed VAA is undefined.");
    }
    if (ctx.vaaBytes === undefined) {
      throw new UnrecoverableError("Raw VAA is undefined.");
    }

    let parsedTokenTransferVaa;
    let payload;
    if (isTokenBridgeVaa(ctx.env, ctx.vaa)) {
      parsedTokenTransferVaa = tryToParseTokenTransferVaa(ctx.vaaBytes);
      if (parsedTokenTransferVaa !== undefined) {
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
      payload,
    };
    ctx.logger?.debug("Token Bridge contracts attached to context");
    await next();
  };
}
