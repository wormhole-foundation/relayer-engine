/// <reference types="node" />
import * as ethers from "ethers";
import * as solana from "@solana/web3.js";
import { ChainId, EVMChainId } from "@certusone/wormhole-sdk";
import * as winston from "winston";
export interface CommonPluginEnv {
    supportedChains: ChainConfigInfo[];
}
export declare enum EnvType {
    MAINNET = "MAINNET",
    DEVNET = "DEVNET",
    TILT = "TILT",
    LOCALHOST = "LOCALHOST",
    OTHER = "OTHER"
}
export interface ChainConfigInfo {
    chainId: ChainId;
    chainName: string;
    nodeUrl: string;
    tokenBridgeAddress?: string;
    bridgeAddress?: string;
    wrappedAsset?: string | null;
}
export interface Workflow<D = any> {
    id: ActionId;
    pluginName: string;
    data: D;
}
export interface ActionExecutor {
    <T, W extends Wallet>(action: Action<T, W>): Promise<T>;
    onSolana<T>(f: ActionFunc<T, SolanaWallet>): Promise<T>;
    onEVM<T>(action: Action<T, EVMWallet>): Promise<T>;
}
export declare type ActionFunc<T, W extends Wallet> = (walletToolBox: WalletToolBox<W>, chaidId: ChainId) => Promise<T>;
export interface Action<T, W extends Wallet> {
    chainId: ChainId;
    f: ActionFunc<T, W>;
}
export declare type ActionId = number;
export declare type WorkflowId = number;
export declare type StagingArea = Object;
export declare type EVMWallet = ethers.Wallet;
export declare type Wallet = EVMWallet | SolanaWallet | CosmWallet;
export interface WalletToolBox<T extends Wallet> extends Providers {
    wallet: T;
}
export declare type SolanaWallet = {
    conn: solana.Connection;
    payer: solana.Keypair;
};
export declare type CosmWallet = {};
export interface Providers {
    evm: {
        [id in EVMChainId]: ethers.providers.Provider;
    };
    solana: solana.Connection;
}
export interface Plugin<WorkflowData = any> {
    pluginName: string;
    pluginConfig: any;
    shouldSpy: boolean;
    shouldRest: boolean;
    demoteInProgress?: boolean;
    getFilters(): ContractFilter[];
    consumeEvent(// Function to be defined in plug-in that takes as input a VAA outputs a list of actions
    vaa: Buffer, stagingArea: StagingArea, providers: Providers): Promise<{
        workflowData?: WorkflowData;
        nextStagingArea: StagingArea;
    }>;
    handleWorkflow(workflow: Workflow<WorkflowData>, providers: Providers, execute: ActionExecutor): Promise<void>;
}
export interface PluginFactory {
    init(config: CommonPluginEnv, logger: winston.Logger): Plugin;
    pluginName: string;
}
export declare type ContractFilter = {
    emitterAddress: string;
    chainId: ChainId;
};
