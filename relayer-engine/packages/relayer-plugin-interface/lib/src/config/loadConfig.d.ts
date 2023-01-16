import { Mode, PrivateKeys } from ".";
import { ChainId } from "@certusone/wormhole-sdk";
export declare function loadUntypedEnvs(dir: string, mode: Mode, { privateKeyEnv }?: {
    privateKeyEnv?: boolean;
}): Promise<{
    mode: Mode;
    rawCommonEnv: any;
    rawListenerEnv: any;
    rawExecutorEnv: any;
}>;
export declare function loadFileAndParseToObject(path: string): Promise<Record<string, any>>;
export declare function privateKeyEnvVarLoader(chains: ChainId[]): PrivateKeys;
