import * as wormholeSdk from "@certusone/wormhole-sdk";
export declare function encodeEmitterAddress(chainId: wormholeSdk.ChainId, emitterAddressStr: string): string;
export declare function sleep(ms: number): Promise<unknown>;
/**
 * Simple object check.
 * @param item
 * @returns {boolean}
 */
export declare function isObject(item: any): boolean;
/**
 * Deep merge two objects.
 * @param target
 * @param ...sources
 */
export declare function mergeDeep<T>(target: Partial<T>, ...sources: Partial<T>[]): T;
