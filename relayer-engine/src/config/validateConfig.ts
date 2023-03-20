/*
 * Takes in untyped, resolved config objects, validates them and returns typed config objects
 */
import { ChainConfigInfo } from "../../packages/relayer-plugin-interface";
import { ChainId } from "@certusone/wormhole-sdk";
import { CommonEnv, ExecutorEnv, ListenerEnv, Mode, StoreType, TokenMonitoringInfo } from ".";
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
  validateTokensToMonitor(raw.tokensToMonitor, chainIds)

  return {
    tokensToMonitor: raw.tokensToMonitor,
    privateKeys: validatePrivateKeys(raw.privateKeys, chainIds),
    actionInterval:
      raw.actionInterval && assertInt(raw.actionInterval, "actionInterval"),
  };
}

//Polygon is not supported on local Tilt network atm.
export function validateChainConfig(
  supportedChainRaw: Keys<ChainConfigInfo>,
): ChainConfigInfo {
  const msg = (fieldName: string) =>
    `Missing required field in chain config: ${fieldName}`;

  return {
    chainId: nnull(supportedChainRaw.chainId, msg("chainId")),
    chainName: nnull(supportedChainRaw.chainName, msg("chainName")),
    nodeUrl: nnull(supportedChainRaw.nodeUrl, msg("nodeUrl")),
    nativeCurrencySymbol: supportedChainRaw.nativeCurrencySymbol,
    tokenBridgeAddress: supportedChainRaw.tokenBridgeAddress,
  };
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
      throw new EngineError(`privateKeys includes key for unsupported chain ${chainId}`);
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

function validateTokenToMonitor(token: any): token is TokenMonitoringInfo {
  const requiredProperties = ['chainId', 'address'];
  const missingProperties = requiredProperties.filter((prop: string) => !token.hasOwnProperty(prop));
  if (missingProperties.length > 0) {
    throw new EngineError(`tokensToMonitor includes token without required properties ${missingProperties.join(', ')}`);
  };

  if (requiredProperties.length !== Object.keys(token).length) {
    throw new EngineError(`tokensToMonitor includes token with invalid properties ${JSON.stringify(token)}`);
  }

  return true
}

function validateTokensToMonitor(
  tokensToMonitor: any[],
  chainIds: number[],
): tokensToMonitor is TokenMonitoringInfo[] {
  const tokenSet = new Set();
  const chainIdsSet = new Set(chainIds);

  tokensToMonitor.forEach(token => {
    validateTokenToMonitor(token);

    if (!chainIdsSet.has(token.chainId)) {
      throw new EngineError(`tokensToMonitor includes token for unsupported chain: ${token.chainId}`);
    }

    const key = `${token.chainId}-${token.address}`;
    if (tokenSet.has(key)) {
      throw new EngineError(`tokensToMonitor includes duplicate token. chainId: ${token.chainId}`);
    } else {
      tokenSet.add(key);
    }
  });

  return true;
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
