import { parseVaa, SignedVaa } from "@certusone/wormhole-sdk";
import { ParsedVaaWithBytes } from "relayer-plugin-interface";

export class EngineError extends Error {
  constructor(msg: string, public args?: Record<any, any>) {
    super(msg);
  }
}

export function nnull<T>(x: T | undefined | null, errMsg?: string): T {
  if (x === undefined || x === null) {
    throw new Error("Found unexpected undefined or null. " + errMsg);
  }
  return x;
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

export function parseVaaWithBytes(vaa: SignedVaa): ParsedVaaWithBytes {
  const parsedVaa = parseVaa(vaa) as ParsedVaaWithBytes;
  parsedVaa.bytes = Buffer.from(vaa);
  return parsedVaa;
}
