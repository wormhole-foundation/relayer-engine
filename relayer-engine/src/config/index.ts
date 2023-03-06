import { ChainId } from "@certusone/wormhole-sdk";
import {
  ChainConfigInfo,
  CommonPluginEnv,
  EnvType,
  WorkflowOptions,
} from "../../packages/relayer-plugin-interface";
import { loadUntypedEnvs } from "./loadConfig";
import {
  transformPrivateKeys,
  validateCommonEnv,
  validateExecutorEnv,
  validateListenerEnv,
} from "./validateConfig";

export {
  loadFileAndParseToObject,
  loadUntypedEnvs,
  privateKeyEnvVarLoader,
} from "./loadConfig";
export { validateStringEnum } from "./validateConfig";

type RelayerEngineConfigs = {
  commonEnv: CommonEnv;
  listenerEnv?: ListenerEnv;
  executorEnv?: ExecutorEnv;
};

export enum StoreType {
  Redis = "Redis",
}

export enum Mode {
  LISTENER = "LISTENER",
  EXECUTOR = "EXECUTOR",
  BOTH = "BOTH",
}
export type NodeURI = string;

export interface RedisConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: boolean;
  cluster?: boolean;
}

export interface CommonEnv {
  namespace?: string;
  logLevel?: string;
  logFormat?: "json" | "console" | "";
  promPort?: number;
  apiPort?: number;
  apiKey?: string;
  readinessPort?: number;
  logDir?: string;
  storeType: StoreType;
  redis?: RedisConfig;
  pluginURIs?: NodeURI[];
  numGuardians?: number;
  wormholeRpc: string;
  mode: Mode;
  supportedChains: ChainConfigInfo[];
  defaultWorkflowOptions: WorkflowOptions;
}
// assert CommonEnv is superset of CommonPluginEnv
let _x: CommonPluginEnv = {} as CommonEnv;

export type ListenerEnv = {
  spyServiceHost: string;
  nextVaaFetchingWorkerTimeoutSeconds?: number;
  restPort?: number;
};

export type PrivateKeys = { [id in ChainId]: string[] };
export type ExecutorEnv = {
  privateKeys: PrivateKeys;
  actionInterval?: number; // milliseconds between attempting to process actions
};

export type SupportedToken = {
  chainId: ChainId;
  address: string;
};

let loggingEnv: CommonEnv | undefined = undefined;
let executorEnv: ExecutorEnv | undefined = undefined;
let commonEnv: CommonEnv | undefined = undefined;
let listenerEnv: ListenerEnv | undefined = undefined;

export function getCommonEnv(): CommonEnv {
  if (!commonEnv) {
    throw new Error(
      "Tried to get CommonEnv but it does not exist. Has it been loaded yet?",
    );
  }
  return commonEnv;
}

export function getExecutorEnv(): ExecutorEnv {
  if (!executorEnv) {
    throw new Error(
      "Tried to get ExecutorEnv but it does not exist. Has it been loaded yet?",
    );
  }
  return executorEnv;
}

export function getListenerEnv(): ListenerEnv {
  if (!listenerEnv) {
    throw new Error(
      "Tried to get ListenerEnv but it does not exist. Has it been loaded yet?",
    );
  }
  return listenerEnv;
}

export function loadRelayerEngineConfig(
  dir: string,
  mode: Mode,
  { privateKeyEnv = true }: { privateKeyEnv?: boolean } = {
    privateKeyEnv: true,
  },
): Promise<RelayerEngineConfigs> {
  return loadUntypedEnvs(dir, mode, { privateKeyEnv }).then(validateEnvs);
}

export function transformEnvs({
  mode,
  rawCommonEnv,
  rawListenerEnv,
  rawExecutorEnv,
}: {
  mode: Mode;
  rawCommonEnv: any;
  rawListenerEnv: any;
  rawExecutorEnv: any;
}) {
  return {
    mode,
    rawCommonEnv,
    rawListenerEnv,
    rawExecutorEnv: {
      ...rawExecutorEnv,
      privateKeys: transformPrivateKeys(rawExecutorEnv.privateKeys),
    },
  };
}

export function validateEnvs(input: {
  mode: Mode;
  rawCommonEnv: any;
  rawListenerEnv: any;
  rawExecutorEnv: any;
}): {
  commonEnv: CommonEnv;
  listenerEnv?: ListenerEnv;
  executorEnv?: ExecutorEnv;
} {
  console.log("Validating envs...");
  try {
    input = transformEnvs(input);
  } catch (e) {}
  commonEnv = validateCommonEnv(input.rawCommonEnv);
  if (input.rawExecutorEnv) {
    executorEnv = validateExecutorEnv(
      input.rawExecutorEnv,
      commonEnv.supportedChains.map(c => c.chainId),
    );
  }
  if (input.rawListenerEnv) {
    listenerEnv = validateListenerEnv(input.rawListenerEnv);
  }
  console.log("Validated envs");
  return {
    executorEnv,
    listenerEnv,
    commonEnv,
  };
}
