/*
 * Takes in untyped, resolved config objects and sets typed config objects
 */
import {
  ChainConfigInfo,
  EnvType,
} from "../../packages/relayer-plugin-interface";
import {
  ChainId,
  CHAIN_ID_SOLANA,
  isEVMChain,
  isTerraChain,
} from "@certusone/wormhole-sdk";
import { CommonEnv, ExecutorEnv, ListenerEnv, Mode, StoreType } from ".";
import {
  assertArray,
  assertBool,
  assertInt,
  assertStr,
  EngineError,
  nnull,
} from "../utils/utils";

type ConfigPrivateKey = {
  chainId: ChainId;
  privateKeys: string[] | number[][];
};

export function validateCommonEnv(raw: Keys<CommonEnv>): CommonEnv {
  return {
    namespace: raw.namespace,
    logLevel: raw.logLevel,
    storeType: validateStringEnum<StoreType>(StoreType, raw.storeType),
    redis: {
      host: raw.redis?.host,
      port: raw.redis?.port && assertInt(raw.redis?.port, "redis.port"),
      username: raw.redis?.username,
      password: raw.redis?.password,
      tls: raw.redis?.tls && assertBool(raw.redis?.tls, "redis.tls"),
      cluster:
        raw.redis?.cluster && assertBool(raw.redis?.cluster, "redis.cluster"),
    },
    pluginURIs: raw.pluginURIs && assertArray(raw.pluginURIs, "pluginURIs"),
    mode: validateStringEnum<Mode>(Mode, raw.mode),
    promPort: raw.promPort && assertInt(raw.promPort, "promPort"),
    apiPort: raw.apiPort && assertInt(raw.apiPort, "apiPort"),
    apiKey: raw.apiKey || process.env.RELAYER_ENGINE_API_KEY,
    defaultWorkflowOptions: {
      maxRetries: assertInt(raw.defaultWorkflowOptions.maxRetries),
    },
    readinessPort:
      raw.readinessPort && assertInt(raw.readinessPort, "readinessPort"),
    logDir: raw.logDir,
    logFormat: raw.logFormat,
    supportedChains: assertArray<Keys<ChainConfigInfo>>(
      raw.supportedChains,
      "supportedChains",
    ).map(validateChainConfig),
    numGuardians:
      raw.numGuardians && assertInt(raw.numGuardians, "numGuardians"),
    wormholeRpc: assertStr(raw.wormholeRpc, "wormholeRpc"),
  };
}

export function validateListenerEnv(raw: Keys<ListenerEnv>): ListenerEnv {
  return {
    spyServiceHost: raw.spyServiceHost,
    nextVaaFetchingWorkerTimeoutSeconds:
      raw.nextVaaFetchingWorkerTimeoutSeconds &&
      assertInt(
        raw.nextVaaFetchingWorkerTimeoutSeconds,
        "nextVaaFetchingWorkerTimeoutSeconds",
      ),
    restPort: raw.restPort ? assertInt(raw.restPort, "restPort") : undefined,
  };
}

export function validateExecutorEnv(
  raw: Keys<ExecutorEnv & { privateKeys: ConfigPrivateKey[] }>,
  chainIds: number[],
): ExecutorEnv {
  return {
    privateKeys: validatePrivateKeys(raw.privateKeys, chainIds),
    actionInterval:
      raw.actionInterval && assertInt(raw.actionInterval, "actionInterval"),
  };
}

//Polygon is not supported on local Tilt network atm.
export function validateChainConfig(
  supportedChainRaw: Keys<ChainConfigInfo>,
): ChainConfigInfo {
  if (!supportedChainRaw.chainId) {
    throw new Error("Invalid chain config: " + supportedChainRaw);
  }
  if (supportedChainRaw.chainId === CHAIN_ID_SOLANA) {
    return createSolanaChainConfig(supportedChainRaw);
  } else if (isTerraChain(supportedChainRaw.chainId)) {
    return createTerraChainConfig(supportedChainRaw);
  } else if (isEVMChain(supportedChainRaw.chainId)) {
    return createEvmChainConfig(supportedChainRaw);
  } else {
    throw new Error(
      `Unrecognized chain ${supportedChainRaw.chainId} ${supportedChainRaw.chainName}`,
    );
  }
}

export function transformPrivateKeys(privateKeys: any): {
  [chainId in ChainId]: string[];
} {
  return Object.fromEntries(
    assertArray(privateKeys, "privateKeys").map((obj: any) => {
      const { chainId, privateKeys } = obj;
      assertInt(chainId, "chainId");
      assertArray(privateKeys, "privateKeys");
      return [chainId, privateKeys];
    }),
  );
}

function validatePrivateKeys(
  privateKeys: any,
  chainIds: number[],
): {
  [chainId in ChainId]: string[];
} {
  const set = new Set(chainIds);
  Object.entries(privateKeys).forEach(([chainId, pKeys]) => {
    if (!set.has(Number(chainId))) {
      throw new EngineError("privateKeys includes key for unsupported chain", {
        chainId,
      });
    }
    assertInt(chainId, "chainId");
    assertArray(pKeys, "privateKeys").forEach((key: any) => {
      if (typeof key !== "string") {
        throw new Error(
          "Private key must be string type, found: " + typeof key,
        );
      }
    });
  });
  if (!chainIds.every(c => privateKeys[c])) {
    throw new EngineError("privateKeys missing key from supported chains", {
      chains: chainIds.filter(c => !privateKeys[c]),
    });
  }
  return privateKeys;
}

function createSolanaChainConfig(
  config: Keys<ChainConfigInfo>,
): ChainConfigInfo {
  const msg = (fieldName: string) =>
    `Missing required field in chain config: ${fieldName}`;

  return {
    chainId: nnull(config.chainId, msg("chainId")),
    chainName: nnull(config.chainName, msg("chainName")),
    nodeUrl: nnull(config.nodeUrl, msg("nodeUrl")),
    tokenBridgeAddress: config.tokenBridgeAddress,
    bridgeAddress: nnull(config.bridgeAddress, msg("bridgeAddress")),
    wrappedAsset: config.wrappedAsset,
  };
}

function createTerraChainConfig(config: any): ChainConfigInfo {
  const msg = (fieldName: string) =>
    `Missing required field in chain config: ${fieldName}`;
  return {
    chainId: nnull(config.chainId, msg("chainId")),
    chainName: nnull(config.chainName, msg("chainName")),
    nodeUrl: nnull(config.nodeUrl, msg("nodeUrl")),
    tokenBridgeAddress: config.tokenBridgeAddress,
  };
}

function createEvmChainConfig(config: any): ChainConfigInfo {
  const msg = (fieldName: string) =>
    `Missing required field in chain config: ${fieldName}`;
  return {
    chainId: nnull(config.chainId, msg("chainId")),
    chainName: nnull(config.chainName, msg("chainName")),
    nodeUrl: nnull(config.nodeUrl, msg("nodeUrl")),
    tokenBridgeAddress: config.tokenBridgeAddress,
    bridgeAddress: config.bridgeAddress,
    wrappedAsset: config.wrappedAsset,
  };
}

export type Keys<T> = { [k in keyof T]: any };
export function validateStringEnum<B>(
  enumObj: Object,
  value: string | undefined,
): B {
  if (Object.values(enumObj).includes(value)) {
    return value as unknown as B;
  }
  const e = new Error("Expected value to be member of enum") as any;
  e.value = value;
  e.enumVariants = Object.values(enumObj);
  throw e;
}

/* We should do typesafe key validation, but this may require types specific to the on-disk config format, not the resolved config objects

const commonEnvKeys = createKeys<CommonEnv>({
  logDir: 1,
  logLevel: 1,
  readinessPort: 1,
  redisHost: 1,
  redisPort: 1,
  pluginURIs: 1,
  promPort: 1,
  envType: 1,
});
const listenerEnvKeys = createKeys<ListenerEnv>({
  spyServiceFilters: 1,
  spyServiceHost: 1,
  numSpyWorkers: 1,
  restPort: 1,
});
const executorEnvKeys = createKeys<ExecutorEnv>({
  redisHost: 1,
  redisPort: 1,
  supportedChains: 1,
});

function validateKeys<T>(keys: (keyof T)[], obj: Record<string, any>): Keys<T> {
  for (const key of keys) {
    if (!obj[key as string]) {
      throw new Error(`${String(key)} missing from object`);
    }
  }
  if (!Object.keys(obj).every(k => keys.includes(k as any))) {
    throw new Error(
      `Object includes keys missing from ${String(
        keys
      )}. Obj keys ${Object.keys(obj)}`
    );
  }
  return obj as { [k in keyof T]: any };
}

function createKeys<T>(keyRecord: Record<keyof T, any>): (keyof T)[] {
  return Object.keys(keyRecord) as any;
}
*/
