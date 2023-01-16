import { ChainId } from "@certusone/wormhole-sdk";
import { ChainConfigInfo } from "relayer-plugin-interface";
import { WorkflowOptions } from "../../lib";
export { loadFileAndParseToObject, loadUntypedEnvs, privateKeyEnvVarLoader, } from "./loadConfig";
export { validateStringEnum } from "./validateConfig";
declare type RelayerEngineConfigs = {
    commonEnv: CommonEnv;
    listenerEnv?: ListenerEnv;
    executorEnv?: ExecutorEnv;
};
export declare enum Mode {
    LISTENER = "LISTENER",
    EXECUTOR = "EXECUTOR",
    BOTH = "BOTH"
}
export declare type NodeURI = string;
export interface CommonEnv {
    logLevel?: string;
    promPort?: number;
    readinessPort?: number;
    logDir?: string;
    redisHost?: string;
    redisPort?: number;
    pluginURIs?: NodeURI[];
    numGuardians?: number;
    mode: Mode;
    supportedChains: ChainConfigInfo[];
    defaultWorkflowOptions: WorkflowOptions;
}
export declare type ListenerEnv = {
    spyServiceHost: string;
    restPort?: number;
};
export declare type PrivateKeys = {
    [id in ChainId]: string[];
};
export declare type ExecutorEnv = {
    privateKeys: PrivateKeys;
    actionInterval?: number;
};
export declare type SupportedToken = {
    chainId: ChainId;
    address: string;
};
export declare function getCommonEnv(): CommonEnv;
export declare function getExecutorEnv(): ExecutorEnv;
export declare function getListenerEnv(): ListenerEnv;
export declare function loadRelayerEngineConfig(dir: string, mode: Mode, { privateKeyEnv }?: {
    privateKeyEnv?: boolean;
}): Promise<RelayerEngineConfigs>;
export declare function transformEnvs({ mode, rawCommonEnv, rawListenerEnv, rawExecutorEnv, }: {
    mode: Mode;
    rawCommonEnv: any;
    rawListenerEnv: any;
    rawExecutorEnv: any;
}): {
    mode: Mode;
    rawCommonEnv: any;
    rawListenerEnv: any;
    rawExecutorEnv: any;
};
export declare function validateEnvs(input: {
    mode: Mode;
    rawCommonEnv: any;
    rawListenerEnv: any;
    rawExecutorEnv: any;
}): {
    commonEnv: CommonEnv;
    listenerEnv?: ListenerEnv;
    executorEnv?: ExecutorEnv;
};
