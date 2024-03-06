import { ethers_contracts as EvmTokenBridgeContracts } from "@wormhole-foundation/sdk-evm-tokenbridge";
import {
  Chain,
  ChainId,
  Network,
  TokenBridge,
  VAA,
  contracts,
  deserialize,
  toChain,
  toChainId,
} from "@wormhole-foundation/sdk";
import { UnrecoverableError } from "bullmq";
import { Signer, ethers } from "ethers";
import { Middleware } from "../compose.middleware.js";
import { Environment } from "../environment.js";
import { encodeEmitterAddress, envToNetwork } from "../utils.js";
import { ProviderContext } from "./providers.middleware.js";

type ITokenBridge = EvmTokenBridgeContracts.TokenBridgeContract;

function tokenBridgeMap(network: Network): Record<string, string> {
  return Object.fromEntries(
    contracts
      .tokenBridgeChains(network)
      // TODO: ben
      // @ts-ignore
      .map(chain => [chain, contracts.tokenBridge(network, chain)]),
  );
}

const tokenBridgeAddresses = {
  [Environment.MAINNET]: tokenBridgeMap("Mainnet"),
  [Environment.TESTNET]: tokenBridgeMap("Testnet"),
  [Environment.DEVNET]: tokenBridgeMap("Devnet"),
};

export interface TokenBridgeContext extends ProviderContext {
  tokenBridge: {
    addresses: {
      [k in Chain]?: string;
    };
    contractConstructor: (
      address: string,
      signerOrProvider: Signer | ethers.providers.Provider,
    ) => ITokenBridge;
    contracts: {
      read: {
        evm: {
          [k in ChainId]?: ITokenBridge[];
        };
      };
    };
    vaa?: VAA<"TokenBridge:Transfer" | "TokenBridge:TransferWithPayload">;
    payload?: TokenBridge.Payload;
  };
}

export type TokenBridgeChainConfigInfo = {
  evm: {
    [k in ChainId]: {
      contracts: [];
    };
  };
};

function instantiateReadEvmContracts(
  env: Environment,
  chainRpcs: Partial<Record<Chain, ethers.providers.JsonRpcProvider[]>>,
) {
  const evmChainContracts: Partial<{
    [k in ChainId]: ITokenBridge[];
  }> = {};
  for (const [chainIdStr, chainRpc] of Object.entries(chainRpcs)) {
    const chainId = Number(chainIdStr) as ChainId;
    const address = tokenBridgeAddresses[env][toChain(chainId)];
    const contracts = chainRpc.map(rpc =>
      // TODO: ben
      // @ts-ignore
      EvmTokenBridgeContracts.Bridge__factory.connect(address, rpc),
    );
    evmChainContracts[chainId] = contracts;
  }
  return evmChainContracts;
}

// initialized when then first vaa comes through
let tokenBridgeEmitterCapSui = "";

function isTokenBridgeVaa(env: Environment, vaa: VAA): boolean {
  const chainId = toChainId(vaa.emitterChain);

  let tokenBridgeLocalAddress =
    vaa.emitterChain === "Sui"
      ? tokenBridgeEmitterCapSui
      : tokenBridgeAddresses[env][vaa.emitterChain];
  if (!tokenBridgeLocalAddress) {
    return false;
  }

  const emitterAddress = vaa.emitterAddress.toString();
  let tokenBridgeEmitterAddress = encodeEmitterAddress(
    chainId,
    tokenBridgeLocalAddress,
  );
  return tokenBridgeEmitterAddress === emitterAddress;
}

function tryToParseTokenTransferVaa(
  vaaBytes: Uint8Array,
): TokenBridge.TransferVAA | undefined {
  try {
    return deserialize(TokenBridge.getTransferDiscriminator(), vaaBytes);
  } catch (e) {
    // it may not be a token transfer vaa. TODO Maybe we want to do something to support attestations etc.
    return undefined;
  }
}

export function tokenBridgeContracts(): Middleware<TokenBridgeContext> {
  let evmContracts: Partial<{ [k in ChainId]: ITokenBridge[] }>;
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
      const fields = null;
      // TODO: ben
      // await getObjectFields(
      //   ctx.providers.sui[0],
      //   contracts.tokenBridge.get(envToNetwork(ctx.env), "Sui")!,
      // );
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
        const pl = parsedTokenTransferVaa.payload;
        // TODO: ben
        // payload = {
        //   payloadType: parsedTokenTransferVaa.payloadName,
        //   amount: pl.token.amount,
        //   tokenAddress: pl.token.address.toString(),
        //   tokenChain: pl.token.chain,
        //   to: pl.to.address.toString(),
        //   toChain: pl.to.chain,
        //   fee: parsedTokenTransferVaa.fee,
        // };

        // if(parsedTokenTransferVaa.payloadName === "TransferWithPayload") {
        //   //tokenTransferPayload: parsedTokenTransferVaa.tokenTransferPayload,
        //   payload = {...payload, fromAddress: parsedTokenTransferVaa.payload.from.toString(), tokenTransferPayload: "", fee: parsedTokenTransferVaa.payload},
        // }
      }
    }

    ctx.tokenBridge = {
      addresses: tokenBridgeAddresses[ctx.env],
      // TODO: ben
      // @ts-ignore
      contractConstructor: EvmTokenBridgeContracts.Bridge__factory.connect,
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
