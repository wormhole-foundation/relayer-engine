"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateStringEnum = exports.transformPrivateKeys = exports.validateChainConfig = exports.validateExecutorEnv = exports.validateListenerEnv = exports.validateCommonEnv = void 0;
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const _1 = require(".");
const utils_1 = require("../utils/utils");
function validateCommonEnv(raw) {
    return {
        logLevel: raw.logLevel,
        redisHost: raw.redisHost,
        redisPort: raw.redisPort && (0, utils_1.assertInt)(raw.redisPort, "redisPort"),
        pluginURIs: raw.pluginURIs && (0, utils_1.assertArray)(raw.pluginURIs, "pluginURIs"),
        mode: validateStringEnum(_1.Mode, raw.mode),
        promPort: raw.promPort && (0, utils_1.assertInt)(raw.promPort, "promPort"),
        defaultWorkflowOptions: {
            maxRetries: (0, utils_1.assertInt)(raw.defaultWorkflowOptions.maxRetries),
        },
        readinessPort: raw.readinessPort && (0, utils_1.assertInt)(raw.readinessPort, "readinessPort"),
        logDir: raw.logDir,
        supportedChains: (0, utils_1.assertArray)(raw.supportedChains, "supportedChains").map(validateChainConfig),
        numGuardians: raw.numGuardians && (0, utils_1.assertInt)(raw.numGuardians, "numGuardians"),
    };
}
exports.validateCommonEnv = validateCommonEnv;
function validateListenerEnv(raw) {
    return {
        spyServiceHost: raw.spyServiceHost,
        restPort: raw.restPort ? (0, utils_1.assertInt)(raw.restPort, "restPort") : undefined,
    };
}
exports.validateListenerEnv = validateListenerEnv;
function validateExecutorEnv(raw, chainIds) {
    return {
        privateKeys: validatePrivateKeys(raw.privateKeys, chainIds),
        actionInterval: raw.actionInterval && (0, utils_1.assertInt)(raw.actionInterval, "actionInterval"),
    };
}
exports.validateExecutorEnv = validateExecutorEnv;
//Polygon is not supported on local Tilt network atm.
function validateChainConfig(supportedChainRaw) {
    if (!supportedChainRaw.chainId) {
        throw new Error("Invalid chain config: " + supportedChainRaw);
    }
    if (supportedChainRaw.chainId === wormhole_sdk_1.CHAIN_ID_SOLANA) {
        return createSolanaChainConfig(supportedChainRaw);
    }
    else if ((0, wormhole_sdk_1.isTerraChain)(supportedChainRaw.chainId)) {
        return createTerraChainConfig(supportedChainRaw);
    }
    else if ((0, wormhole_sdk_1.isEVMChain)(supportedChainRaw.chainId)) {
        return createEvmChainConfig(supportedChainRaw);
    }
    else {
        throw new Error(`Unrecognized chain ${supportedChainRaw.chainId} ${supportedChainRaw.chainName}`);
    }
}
exports.validateChainConfig = validateChainConfig;
function transformPrivateKeys(privateKeys) {
    return Object.fromEntries((0, utils_1.assertArray)(privateKeys, "privateKeys").map((obj) => {
        const { chainId, privateKeys } = obj;
        (0, utils_1.assertInt)(chainId, "chainId");
        (0, utils_1.assertArray)(privateKeys, "privateKeys");
        return [chainId, privateKeys];
    }));
}
exports.transformPrivateKeys = transformPrivateKeys;
function validatePrivateKeys(privateKeys, chainIds) {
    const set = new Set(chainIds);
    Object.entries(privateKeys).forEach(([chainId, pKeys]) => {
        if (!set.has(Number(chainId))) {
            throw new utils_1.EngineError("privateKeys includes key for unsupported chain", {
                chainId,
            });
        }
        (0, utils_1.assertInt)(chainId, "chainId");
        (0, utils_1.assertArray)(pKeys, "privateKeys").forEach((key) => {
            if (typeof key !== "string") {
                throw new Error("Private key must be string type, found: " + typeof key);
            }
        });
    });
    if (!chainIds.every(c => privateKeys[c])) {
        throw new utils_1.EngineError("privateKeys missing key from supported chains", {
            chains: chainIds.filter(c => !privateKeys[c]),
        });
    }
    return privateKeys;
}
function createSolanaChainConfig(config) {
    const msg = (fieldName) => `Missing required field in chain config: ${fieldName}`;
    return {
        chainId: (0, utils_1.nnull)(config.chainId, msg("chainId")),
        chainName: (0, utils_1.nnull)(config.chainName, msg("chainName")),
        nodeUrl: (0, utils_1.nnull)(config.nodeUrl, msg("nodeUrl")),
        tokenBridgeAddress: config.tokenBridgeAddress,
        bridgeAddress: (0, utils_1.nnull)(config.bridgeAddress, msg("bridgeAddress")),
        wrappedAsset: config.wrappedAsset,
    };
}
function createTerraChainConfig(config) {
    const msg = (fieldName) => `Missing required field in chain config: ${fieldName}`;
    return {
        chainId: (0, utils_1.nnull)(config.chainId, msg("chainId")),
        chainName: (0, utils_1.nnull)(config.chainName, msg("chainName")),
        nodeUrl: (0, utils_1.nnull)(config.nodeUrl, msg("nodeUrl")),
        tokenBridgeAddress: config.tokenBridgeAddress,
    };
}
function createEvmChainConfig(config) {
    const msg = (fieldName) => `Missing required field in chain config: ${fieldName}`;
    return {
        chainId: (0, utils_1.nnull)(config.chainId, msg("chainId")),
        chainName: (0, utils_1.nnull)(config.chainName, msg("chainName")),
        nodeUrl: (0, utils_1.nnull)(config.nodeUrl, msg("nodeUrl")),
        tokenBridgeAddress: config.tokenBridgeAddress,
        bridgeAddress: config.bridgeAddress,
        wrappedAsset: config.wrappedAsset,
    };
}
function validateStringEnum(enumObj, value) {
    if (Object.values(enumObj).includes(value)) {
        return value;
    }
    const e = new Error("Expected value to be member of enum");
    e.value = value;
    e.enumVariants = Object.values(enumObj);
    throw e;
}
exports.validateStringEnum = validateStringEnum;
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
//# sourceMappingURL=validateConfig.js.map