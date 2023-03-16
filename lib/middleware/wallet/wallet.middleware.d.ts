import { ethers } from "ethers";
import * as solana from "@solana/web3.js";
import { ChainId, EVMChainId } from "@certusone/wormhole-sdk";
import { WalletToolBox } from "./walletToolBox";
import { Middleware } from "../../compose.middleware";
import { ProviderContext } from "../providers.middleware";
import { Logger } from "winston";
export type EVMWallet = ethers.Wallet;
export type SolanaWallet = {
    conn: solana.Connection;
    payer: solana.Keypair;
};
export type Wallet = EVMWallet | SolanaWallet;
export interface Action<T, W extends Wallet> {
    chainId: ChainId;
    f: ActionFunc<T, W>;
}
export type ActionFunc<T, W extends Wallet> = (walletToolBox: WalletToolBox<W>, chaidId: ChainId) => Promise<T>;
export interface ActionWithCont<T, W extends Wallet> {
    action: Action<T, W>;
    pluginName: string;
    resolve: (t: T) => void;
    reject: (reason: any) => void;
}
export interface WorkerInfo {
    id: number;
    targetChainId: ChainId;
    targetChainName: string;
    walletPrivateKey: string;
}
export interface ActionExecutor {
    <T, W extends Wallet>(chaindId: ChainId, f: ActionFunc<T, W>): Promise<T>;
    onSolana<T>(f: ActionFunc<T, SolanaWallet>): Promise<T>;
    onEVM<T>(chainId: EVMChainId, f: ActionFunc<T, EVMWallet>): Promise<T>;
}
export interface WalletContext extends ProviderContext {
    wallets: ActionExecutor;
}
export interface WalletOpts {
    namespace: string;
    privateKeys: Partial<{
        [k in ChainId]: any[];
    }>;
    logger?: Logger;
}
export declare function wallets(opts: WalletOpts): Middleware<WalletContext>;
