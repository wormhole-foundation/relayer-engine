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
export declare class RelayerApp<ContextT extends Context> {
    private pipeline?;
    private errorPipeline?;
    private chainRouters;
    private spyUrl?;
    private rootLogger;
    storage: Storage<ContextT>;
    env: Environment;
    filters: {
        emitterFilter?: {
            chainId?: ChainID;
            emitterAddress?: string;
        };
    }[];
    constructor();
    mainnet(): void;
    testnet(): void;
    devnet(): void;
    use(...middleware: Middleware<ContextT>[] | ErrorMiddleware<ContextT>[]): void;
    processVaa(vaa: Buffer, opts?: any): Promise<void>;
    pushVaaThroughPipeline(vaa: Buffer, opts?: any): Promise<void>;
    chain(chainId: ChainId): ChainRouter<ContextT>;
    private spyFilters;
    spy(url: string): this;
    logger(logger: Logger): void;
    useStorage(storageOptions: StorageOptions): void;
    storageKoaUI(path: string): any;
    private generateChainRoutes;
    listen(): Promise<void>;
    environment(env: Environment): void;
}
declare class ChainRouter<ContextT extends Context> {
    chainId: ChainId;
    _routes: Record<string, VaaRoute<ContextT>>;
    constructor(chainId: ChainId);
    address: (address: string, ...handlers: Middleware<ContextT>[]) => ChainRouter<ContextT>;
    spyFilters: () => {
        emitterFilter: ContractFilter;
    }[];
    routes: () => VaaRoute<ContextT>[];
    process(ctx: ContextT, next: Next): Promise<void>;
}
declare class VaaRoute<ContextT extends Context> {
    chainId: ChainId;
    address: string;
    private handler;
    constructor(chainId: ChainId, address: string, handlers: Middleware<ContextT>[]);
    execute(ctx: ContextT, next: Next): Promise<void>;
    addMiddleware(handlers: Middleware<ContextT>[]): void;
    spyFilter(): {
        emitterFilter: ContractFilter;
    };
}
export declare type ContractFilter = {
    emitterAddress: string;
    chainId: ChainId;
};
export declare function transformEmitterFilter(x: ContractFilter): ContractFilter;
export declare function sleep(ms: number): Promise<unknown>;
