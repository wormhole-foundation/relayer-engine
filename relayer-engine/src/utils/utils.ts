import { parseVaa, SignedVaa } from "@certusone/wormhole-sdk";
import { ParsedVaaWithBytes } from "relayer-plugin-interface";

export function nnull<T>(x: T | undefined | null, errMsg?: string): T {
  if (x === undefined || x === null) {
    throw new Error("Found unexpected undefined or null. " + errMsg);
  }
  return x;
}

export function assertInt(x: any, fieldName?: string): number {
  if (!Number.isInteger(Number(x))) {
    const e = new Error(`Expected field to be integer, found ${x}`) as any;
    e.fieldName = fieldName;
    throw e;
  }
  return x as number;
}

export function assertArray<T>(x: any, fieldName?: string): T[] {
  if (!Array.isArray(x)) {
    const e = new Error(`Expected field to be array, found ${x}`) as any;
    e.fieldName = fieldName;
    throw e;
  }
  return x as T[];
}

export function sleep(ms: number) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}

export function assertBool(x: any, fieldName?: string): boolean {
  if (x !== false && x !== true) {
    const e = new Error(`Expected field to be boolean, found ${x}`) as any;
    e.fieldName = fieldName;
    throw e;
  }
  return x as boolean;
}

export function parseVaaWithBytes(vaa: SignedVaa): ParsedVaaWithBytes {
  const parsedVaa = parseVaa(vaa) as ParsedVaaWithBytes;
  parsedVaa.bytes = vaa;
  return parsedVaa;
}
