import { ParsedVaa } from "@certusone/wormhole-sdk";
import { FetchVaaFn } from "./context";
import { ParsedVaaWithBytes } from "./application";
export type VaaId = {
    emitterChain: ParsedVaa["emitterChain"];
    emitterAddress: ParsedVaa["emitterAddress"];
    sequence: ParsedVaa["sequence"];
};
export type SerializedBatchFetcher = {
    vaaBytes: string[];
    vaaIds: VaaId[];
};
interface VaaBundlerOpts {
    maxAttempts?: number;
    delayBetweenAttemptsInMs?: number;
    vaaIds?: VaaId[];
}
export declare class VaaBundleFetcher {
    private fetchVaa;
    private readonly fetchedVaas;
    private readonly pendingVaas;
    private opts;
    constructor(fetchVaa: FetchVaaFn, opts?: VaaBundlerOpts);
    private idToKey;
    private fetchPending;
    addVaaPayload(parsedVaa: ParsedVaaWithBytes): void;
    /**
     * Adds a vaa payload to the builder. If this vaa was marked as pending, then it's moved to completed.
     * @param vaaBytesArr
     * @private
     */
    private addVaaPayloads;
    get isComplete(): boolean;
    get pctComplete(): number;
    serialize(): SerializedBatchFetcher;
    static deserialize(serialized: SerializedBatchFetcher, fetchVaa: FetchVaaFn): VaaBundleFetcher;
    private export;
    build(): Promise<ParsedVaaWithBytes[]>;
}
export {};
