import { SignedVaa } from "@certusone/wormhole-sdk";
import { ParsedVaaWithBytes } from "relayer-plugin-interface";
export declare class EngineError extends Error {
    args?: Record<any, any> | undefined;
    constructor(msg: string, args?: Record<any, any> | undefined);
}
export declare function nnull<T>(x: T | undefined | null, errMsg?: string): T;
export declare function assertInt(x: any, fieldName?: string): number;
export declare function assertArray<T>(x: any, name: string, elemsPred?: (x: any) => boolean): T[];
export declare function sleep(ms: number): Promise<unknown>;
export declare function assertBool(x: any, fieldName?: string): boolean;
export declare function parseVaaWithBytes(vaa: SignedVaa): ParsedVaaWithBytes;
