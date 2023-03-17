/// <reference types="node" />
import { ChainId } from "@certusone/wormhole-sdk";
import { ErrorMiddleware, Middleware, Next } from "./compose.middleware";
import { Context } from "./context";
import { Logger } from "winston";
import { Storage, StorageOptions } from "./storage";
import { ChainID } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";
import { UnrecoverableError } from "bullmq";
export declare enum Environment {
    MAINNET = "mainnet",
    TESTNET = "testnet",
    DEVNET = "devnet"
}
export { UnrecoverableError };
export interface RelayerAppOpts {
    wormholeRpcs?: string[];
    concurrency?: number;
}
export declare const defaultWormholeRpcs: {
    mainnet: string[];
    testnet: string[];
    devnet: string[];
};
export declare class RelayerApp<ContextT extends Context> {
    env: Environment;
    private pipeline?;
    private errorPipeline?;
    private chainRouters;
    private spyUrl?;
    private rootLogger;
    storage: Storage<ContextT>;
    filters: {
        emitterFilter?: {
            chainId?: ChainID;
            emitterAddress?: string;
        };
    }[];
    private opts;
    constructor(env?: Environment, opts?: RelayerAppOpts);
    multiple(chainsAndAddresses: Partial<{
        [k in ChainId]: string[];
    }>, ...middleware: Middleware<ContextT>[]): void;
    use(...middleware: Middleware<ContextT>[] | ErrorMiddleware<ContextT>[]): void;
    fetchVaa(chain: ChainId | string, emitterAddress: Buffer | string, sequence: bigint | string): Promise<import("@certusone/wormhole-sdk-proto-web/lib/cjs/publicrpc/v1/publicrpc").GetSignedVAAResponse>;
    processVaa(vaa: Buffer, opts?: any): Promise<void>;
    pushVaaThroughPipeline(vaa: Buffer, opts?: any): Promise<void>;
    chain(chainId: ChainId): ChainRouter<ContextT>;
    tokenBridge(chains: ChainId[], ...handlers: Middleware<ContextT>[]): this;
    private spyFilters;
    spy(url: string): this;
    logger(logger: Logger): void;
    useStorage(storageOptions: StorageOptions): void;
    storageKoaUI(path: string): Koa.Middleware<Koa.DefaultState, Koa.DefaultContext, any>;
    private generateChainRoutes;
    listen(): Promise<void>;
    stop(): Promise<void>;
}
declare class ChainRouter<ContextT extends Context> {
    chainId: ChainId;
    _addressHandlers: Record<string, Middleware<ContextT>>;
    constructor(chainId: ChainId);
    address: (address: string, ...handlers: Middleware<ContextT>[]) => ChainRouter<ContextT>;
    spyFilters(): {
        emitterFilter: ContractFilter;
    }[];
    process(ctx: ContextT, next: Next): Promise<void>;
}
export type ContractFilter = {
    emitterAddress: string;
    chainId: ChainId;
};
