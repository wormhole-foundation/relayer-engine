/// <reference types="node" />
import { ChainId } from "@certusone/wormhole-sdk";
import { Middleware, Next } from "./compose.middleware";
import { Context } from "./context";
import { Logger } from "winston";
export declare class RelayerApp<ContextT extends Context> {
    private pipeline?;
    private chainRouters;
    private spyUrl?;
    private rootLogger;
    constructor();
    use(...middleware: Middleware<ContextT>[]): void;
    handleVaa(vaa: Buffer): Promise<void>;
    chain(chainId: ChainId): ChainRouter<ContextT>;
    private spyFilters;
    spy(url: string): this;
    logger(logger: Logger): void;
    private generateChainRoutes;
    listen(): Promise<void>;
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
export {};
