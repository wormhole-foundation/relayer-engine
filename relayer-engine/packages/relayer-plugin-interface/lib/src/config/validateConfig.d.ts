import { ChainConfigInfo } from "relayer-plugin-interface";
import { ChainId } from "@certusone/wormhole-sdk";
import { CommonEnv, ExecutorEnv, ListenerEnv } from ".";
declare type ConfigPrivateKey = {
    chainId: ChainId;
    privateKeys: string[] | number[][];
};
export declare function validateCommonEnv(raw: Keys<CommonEnv>): CommonEnv;
export declare function validateListenerEnv(raw: Keys<ListenerEnv>): ListenerEnv;
export declare function validateExecutorEnv(raw: Keys<ExecutorEnv & {
    privateKeys: ConfigPrivateKey[];
}>, chainIds: number[]): ExecutorEnv;
export declare function validateChainConfig(supportedChainRaw: Keys<ChainConfigInfo>): ChainConfigInfo;
export declare function transformPrivateKeys(privateKeys: any): {
    [chainId in ChainId]: string[];
};
export declare type Keys<T> = {
    [k in keyof T]: any;
};
export declare function validateStringEnum<B>(enumObj: Object, value: string | undefined): B;
export {};
