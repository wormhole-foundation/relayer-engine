import {
  ChainConfigInfo,
  EngineInitFn,
  Plugin,
  WorkflowOptions,
} from "./legacy-plugin-definition.js";
import * as fs from "fs";
import * as nodePath from "path";
import {
  assertArray,
  assertBool,
  assertInt,
  assertStr,
  EngineError,
  nnull,
} from "../../utils.js";
import { StandardRelayerApp } from "../../application-standard.js";
import { defaultLogger } from "../../logging.js";
import { legacyPluginCompat } from "./legacy-plugin.middleware.js";
import { Environment } from "../../environment.js";
import { ChainId } from "@wormhole-foundation/sdk";

type RelayerEngineConfigs = {
  commonEnv: CommonEnv;
  listenerEnv?: ListenerEnv;
  executorEnv?: ExecutorEnv;
};

enum StoreType {
  Redis = "Redis",
}

export enum Mode {
  LISTENER = "LISTENER",
  EXECUTOR = "EXECUTOR",
  BOTH = "BOTH",
}

type NodeURI = string;

interface RedisConfig {
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

export type ListenerEnv = {
  spyServiceHost: string;
  nextVaaFetchingWorkerTimeoutSeconds?: number;
  restPort?: number;
};

type PrivateKeys = { [id in ChainId]: string[] };
export type ExecutorEnv = {
  privateKeys: PrivateKeys;
  actionInterval?: number; // milliseconds between attempting to process actions
};

export type CommonEnvRun = Omit<CommonEnv, "mode">;

export interface RunArgs {
  // for configs, provide file path or config objects
  configs:
    | string
    | {
        commonEnv: CommonEnvRun;
        executorEnv?: ExecutorEnv;
        listenerEnv?: ListenerEnv;
      };
  mode: Mode;
  plugins: { [pluginName: string]: EngineInitFn<Plugin> };
}

/** @deprecated use the app builder directly, see example project for modern APIs or source code for this function*/
export async function run(args: RunArgs, env: Environment): Promise<void> {
  if (Object.keys(args.plugins).length !== 1) {
    defaultLogger.error(
      `Plugin compat layer supports running 1 plugin, ${args.plugins.length} provided`,
    );
  }

  // load engine config
  let configs: {
    commonEnv: CommonEnvRun;
    executorEnv?: ExecutorEnv;
    listenerEnv?: ListenerEnv;
  };
  if (typeof args.configs === "string") {
    configs = await loadRelayerEngineConfig(args.configs, Mode.BOTH, {
      privateKeyEnv: true,
    });
  } else {
    configs = args.configs;
  }
  const { commonEnv, executorEnv, listenerEnv } = configs;

  const redis = configs.commonEnv.redis;
  const app = new StandardRelayerApp(env, {
    name: "legacy_relayer",
    fetchSourceTxhash: false,
    redis: redis
      ? {
          host: redis?.host,
          port: redis?.port,
          // todo: tls: undefined,
          username: redis?.username,
          password: redis?.password,
        }
      : {},
    redisCluster: redis?.cluster
      ? {
          dnsLookup: (address: any, callback: any) => callback(null, address),
          slotsRefreshTimeout: 1000,
          redisOptions: {
            // todo: tls: undefined,
            username: redis?.username,
            password: redis?.password,
          },
        }
      : undefined,
    redisClusterEndpoints: redis?.cluster ? [redis.host] : undefined,
    spyEndpoint: listenerEnv?.spyServiceHost,
    logger: defaultLogger,
    privateKeys: executorEnv?.privateKeys,
  });

  const [pluginName, pluginFn] = Object.entries(args.plugins)[0];
  const plugin = pluginFn(commonEnv, defaultLogger);

  legacyPluginCompat(app, plugin);
  await app.listen();
}

let executorEnv: ExecutorEnv | undefined = undefined;
let commonEnv: CommonEnv | undefined = undefined;
let listenerEnv: ListenerEnv | undefined = undefined;

export function loadRelayerEngineConfig(
  dir: string,
  mode: Mode,
  { privateKeyEnv = true }: { privateKeyEnv?: boolean } = {
    privateKeyEnv: true,
  },
): Promise<RelayerEngineConfigs> {
  return loadUntypedEnvs(dir, mode, { privateKeyEnv }).then(validateEnvs);
}

function transformEnvs({
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

function validateEnvs(input: {
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

/*
 * Takes in untyped, resolved config objects, validates them and returns typed config objects
 */

type ConfigPrivateKey = {
  chainId: ChainId;
  privateKeys: string[] | number[][];
};

function validateCommonEnv(raw: Keys<CommonEnv>): CommonEnv {
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

function validateListenerEnv(raw: Keys<ListenerEnv>): ListenerEnv {
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

function validateExecutorEnv(
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
function validateChainConfig(
  supportedChainRaw: Keys<ChainConfigInfo>,
): ChainConfigInfo {
  const msg = (fieldName: string) =>
    `Missing required field in chain config: ${fieldName}`;

  return {
    chainId: nnull(supportedChainRaw.chainId, msg("chainId")),
    chainName: nnull(supportedChainRaw.chainName, msg("chainName")),
    nodeUrl: nnull(supportedChainRaw.nodeUrl, msg("nodeUrl")),
  };
}

function transformPrivateKeys(privateKeys: any): {
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

type Keys<T> = { [k in keyof T]: any };

function validateStringEnum<B>(enumObj: Object, value: string | undefined): B {
  if (Object.values(enumObj).includes(value)) {
    return value as unknown as B;
  }
  const e = new Error("Expected value to be member of enum") as any;
  e.value = value;
  e.enumVariants = Object.values(enumObj);
  throw e;
}

/*
 * Loads config files and env vars, resolves them into untyped objects
 */

async function loadUntypedEnvs(
  dir: string,
  mode: Mode,
  { privateKeyEnv = false }: { privateKeyEnv?: boolean } = {
    privateKeyEnv: false,
  },
): Promise<{
  mode: Mode;
  rawCommonEnv: any;
  rawListenerEnv: any;
  rawExecutorEnv: any;
}> {
  const rawCommonEnv = await loadCommon(dir);
  rawCommonEnv.mode = mode;
  console.log("Successfully loaded the common config file.");

  const rawListenerEnv = await loadListener(dir, mode);
  const rawExecutorEnv = await loadExecutor(
    dir,
    mode,
    rawCommonEnv,
    privateKeyEnv,
  );
  console.log("Successfully loaded the mode config file.");

  return {
    rawCommonEnv,
    rawListenerEnv,
    rawExecutorEnv,
    mode,
  };
}

async function loadCommon(dir: string): Promise<any> {
  const obj = await loadFileAndParseToObject(nodePath.join(dir, `common.json`));
  if (obj.redis) {
    if (process.env.RELAYER_ENGINE_REDIS_HOST) {
      obj.redis.host = process.env.RELAYER_ENGINE_REDIS_HOST;
    }
    if (process.env.RELAYER_ENGINE_REDIS_USERNAME) {
      obj.redis.username = process.env.RELAYER_ENGINE_REDIS_USERNAME;
    }
    if (process.env.RELAYER_ENGINE_REDIS_PASSWORD) {
      obj.redis.password = process.env.RELAYER_ENGINE_REDIS_PASSWORD;
    }
  }
  return obj;
}

async function loadExecutor(
  dir: string,
  mode: Mode,
  rawCommonEnv: any,
  privateKeyEnv: boolean,
): Promise<any> {
  if (mode == Mode.EXECUTOR || mode == Mode.BOTH) {
    const rawExecutorEnv = await loadFileAndParseToObject(
      nodePath.join(dir, `${Mode.EXECUTOR.toLowerCase()}.json`),
    );

    if (privateKeyEnv) {
      rawExecutorEnv.privateKeys = Object.assign(
        (rawExecutorEnv as ExecutorEnv).privateKeys,
        privateKeyEnvVarLoader(
          (rawCommonEnv as CommonEnv).supportedChains.map(c => c.chainId),
        ),
      );
    }
    return rawExecutorEnv;
  }
  return undefined;
}

async function loadListener(dir: string, mode: Mode): Promise<any> {
  if (mode == Mode.LISTENER || mode == Mode.BOTH) {
    return loadFileAndParseToObject(
      nodePath.join(dir, `${Mode.LISTENER.toLowerCase()}.json`),
    );
  }
  return undefined;
}

// todo: extend to take path w/o extension and look for all supported extensions
export async function loadFileAndParseToObject(
  path: string,
): Promise<Record<string, any>> {
  console.log("About to read contents of : " + path);
  const fileContent = fs.readFileSync(path, { encoding: "utf-8" });
  console.log("Successfully read file contents");
  const ext = nodePath.extname(path);
  switch (ext) {
    case ".json":
      return JSON.parse(fileContent);
    default:
      const err = new Error("Config file has unsupported extension") as any;
      err.ext = ext;
      err.path = path;
      throw err;
  }
}

// Helper to parse private keys from env vars.
// For Solana format is PRIVATE_KEYS_CHAIN_1 => [ 14, 173, 153, ... ]
// For ETH format is PRIVATE_KEYS_CHAIN_2 =>  ["0x4f3 ..."]
function privateKeyEnvVarLoader(chains: ChainId[]): PrivateKeys {
  const pkeys = {} as PrivateKeys;
  for (const chain of chains) {
    const str = process.env[`PRIVATE_KEYS_CHAIN_${chain}`];
    if (!str) {
      console.log(
        `No PRIVATE_KEYS_CHAIN_${chain} env var, falling back to executor.json`,
      );
      continue;
    }
    pkeys[chain] = JSON.parse(str);
  }
  return pkeys;
}
