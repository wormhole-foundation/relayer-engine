import * as wh from "@certusone/wormhole-sdk";
import { Providers, WalletToolBox } from "relayer-plugin-interface";
export declare function createWalletToolbox(providers: Providers, privateKey: string, chainId: wh.ChainId): WalletToolBox<any>;
