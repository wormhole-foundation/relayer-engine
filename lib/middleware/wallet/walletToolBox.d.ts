import * as wh from "@certusone/wormhole-sdk";
import { Providers } from "../providers.middleware";
import { Wallet } from "./wallet.middleware";
export interface WalletToolBox<T extends Wallet> extends Providers {
    wallet: T;
}
export declare function createWalletToolbox(providers: Providers, privateKey: string, chainId: wh.ChainId): WalletToolBox<any>;
