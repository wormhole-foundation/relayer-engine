import { Middleware } from "../compose.middleware";
import { Context } from "../context";
import { ChainId, EVMChainId } from "@certusone/wormhole-sdk";
import { ethers } from "ethers";
import { Connection } from "@solana/web3.js";
export interface Providers {
    evm: Partial<Record<EVMChainId, ethers.providers.JsonRpcProvider[]>>;
    solana: Connection[];
}
export interface ProviderContext extends Context {
    providers: Providers;
}
export type ChainConfigInfo = {
    [k in ChainId]: {
        endpoints: string[];
    };
};
export interface ProvidersOpts {
    chains: Partial<ChainConfigInfo>;
}
/**
 * providers is a middleware that populates `ctx.providers` with provider information
 * @param opts
 */
export declare function providers(opts?: ProvidersOpts): Middleware<ProviderContext>;
