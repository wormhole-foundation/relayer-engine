import * as wormholeSdk from "@certusone/wormhole-sdk";
import { bech32 } from "bech32";
import { deriveWormholeEmitterKey } from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import { zeroPad } from "ethers/lib/utils";
import { parseVaa, SignedVaa } from "@certusone/wormhole-sdk";
import { ParsedVaaWithBytes } from "./application";

export function encodeEmitterAddress(
  chainId: wormholeSdk.ChainId,
  emitterAddressStr: string
): string {
  if (
    chainId === wormholeSdk.CHAIN_ID_SOLANA ||
    chainId === wormholeSdk.CHAIN_ID_PYTHNET
  ) {
    return deriveWormholeEmitterKey(emitterAddressStr)
      .toBuffer()
      .toString("hex");
  }
  if (wormholeSdk.isCosmWasmChain(chainId)) {
    return Buffer.from(
      zeroPad(bech32.fromWords(bech32.decode(emitterAddressStr).words), 32)
    ).toString("hex");
  }
  if (wormholeSdk.isEVMChain(chainId)) {
    return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
  }
  if (wormholeSdk.CHAIN_ID_ALGORAND === chainId) {
    return wormholeSdk.getEmitterAddressAlgorand(BigInt(emitterAddressStr));
  }
  if (wormholeSdk.CHAIN_ID_NEAR === chainId) {
    return wormholeSdk.getEmitterAddressNear(emitterAddressStr);
  }
  throw new Error(`Unrecognized wormhole chainId ${chainId}`);
}

export function sleep(ms: number) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}

/**
 * Simple object check.
 * @param item
 * @returns {boolean}
 */
export function isObject(item: any) {
  return item && typeof item === "object" && !Array.isArray(item);
}

export function parseVaaWithBytes(bytes: SignedVaa): ParsedVaaWithBytes {
  const parsedVaa = parseVaa(bytes);
  return { ...parsedVaa, bytes };
}

/**
 * Deep merge two objects.
 * @param target
 * @param ...sources
 */
export function mergeDeep<T>(target: Partial<T>, sources: Partial<T>[], maxDepth = 10): T {
  if (!sources.length || maxDepth === 0) {
    // @ts-ignore
    return target;
  }
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        mergeDeep(target[key], [source[key]], maxDepth-1);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }

  return mergeDeep(target, sources, maxDepth);
}
