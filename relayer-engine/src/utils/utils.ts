import {
  ChainId,
  EVMChainId,
  isChain,
  isEVMChain,
  parseVaa,
  SignedVaa,
} from "@certusone/wormhole-sdk";
import { ethers } from "ethers";
import { ParsedVaaWithBytes } from "../../packages/relayer-plugin-interface";

export const second = 1000;
export const minute = 60 * second;
export const hour = 60 * minute;

export class EngineError extends Error {
  constructor(msg: string, public args?: Record<any, any>) {
    super(msg);
  }
}

export function maybeConcat<T>(...arrs: (T[] | undefined)[]): T[] {
  return arrs.flatMap(arr => (arr ? arr : []));
}

export function nnull<T>(x: T | undefined | null, errMsg?: string): T {
  if (x === undefined || x === null) {
    throw new Error("Found unexpected undefined or null. " + errMsg);
  }
  return x;
}

export function assertStr(x: any, fieldName?: string): string {
  if (typeof x !== "string") {
    throw new EngineError(`Expected field to be integer, found ${x}`, {
      fieldName,
    }) as any;
  }
  return x as string;
}

export function assertInt(x: any, fieldName?: string): number {
  if (!Number.isInteger(Number(x))) {
    throw new EngineError(`Expected field to be integer, found ${x}`, {
      fieldName,
    }) as any;
  }
  return x as number;
}

export function assertArray<T>(
  x: any,
  name: string,
  elemsPred?: (x: any) => boolean,
): T[] {
  if (!Array.isArray(x) || (elemsPred && !x.every(elemsPred))) {
    throw new EngineError(`Expected value to be array, found ${x}`, {
      name,
    }) as any;
  }
  return x as T[];
}

export function sleep(ms: number) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}

export function assertBool(x: any, fieldName?: string): boolean {
  if (x !== false && x !== true) {
    throw new EngineError(`Expected field to be boolean, found ${x}`, {
      fieldName,
    }) as any;
  }
  return x as boolean;
}

export function parseVaaWithBytes(
  vaa: ParsedVaaWithBytes | SignedVaa,
): ParsedVaaWithBytes {
  // @ts-ignore
  if (vaa?.emitterAddress?.length > 0) {
    return vaa as ParsedVaaWithBytes;
  }
  const parsedVaa = parseVaa(vaa as SignedVaa) as ParsedVaaWithBytes;
  parsedVaa.bytes = Buffer.from(vaa as SignedVaa);
  return parsedVaa;
}

export function wormholeBytesToHex(address: Buffer | Uint8Array): string {
  return ethers.utils.hexlify(address).replace("0x", "");
}

export function assertEvmChainId(chainId: number): EVMChainId {
  if (!isEVMChain(chainId as ChainId)) {
    throw new EngineError("Expected number to be valid EVM chainId", {
      chainId,
    });
  }
  return chainId as EVMChainId;
}

export function assertChainId(chainId: number): ChainId {
  if (!isChain(chainId)) {
    throw new EngineError("Expected number to be valid chainId", { chainId });
  }
  return chainId as ChainId;
}
