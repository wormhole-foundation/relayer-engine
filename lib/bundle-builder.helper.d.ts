import { ParsedVaa } from "@certusone/wormhole-sdk";
import { FetchVaaFn } from "./context";
import { ParsedVaaWithBytes } from "./application";
export type VaaId = {
    emitterChain: ParsedVaa["emitterChain"];
    emitterAddress: ParsedVaa["emitterAddress"];
    sequence: ParsedVaa["sequence"];
};
export type SerializedBatchBuilder = {
    vaaBytes: string[];
    vaaIds: VaaId[];
    txHash: string;
};
export type VaaBundle = {
    transactionId?: string;
    vaas: ParsedVaaWithBytes[];
};
interface VaaBundlerOpts {
    maxAttempts?: number;
    delayBetweenAttemptsInMs?: number;
    vaaIds?: VaaId[];
    txHash?: string;
}
export declare class VaaBundleBuilder {
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
    serialize(): SerializedBatchBuilder;
    static deserialize(serialized: SerializedBatchBuilder, fetchVaa: FetchVaaFn): VaaBundleBuilder;
    private export;
    build(): Promise<VaaBundle>;
}
export {};
