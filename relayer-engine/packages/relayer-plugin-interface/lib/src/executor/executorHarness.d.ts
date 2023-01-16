import { Action, Plugin, Wallet } from "relayer-plugin-interface";
import { Storage } from "../storage";
import * as wh from "@certusone/wormhole-sdk";
export declare const MAX_ACTIVE_WORKFLOWS = 10;
export interface WorkerInfo {
    id: number;
    targetChainId: wh.ChainId;
    targetChainName: string;
    walletPrivateKey: string;
}
export interface ActionWithCont<T, W extends Wallet> {
    action: Action<T, W>;
    pluginName: string;
    resolve: (t: T) => void;
    reject: (reason: any) => void;
}
export declare function run(plugins: Plugin[], storage: Storage): Promise<void>;
