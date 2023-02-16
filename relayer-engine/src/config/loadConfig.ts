/*
 * Loads config files and env vars, resolves them into untyped objects
 */

import * as yaml from "js-yaml";
import * as fs from "fs";
import * as nodePath from "path";
import { CommonEnv, ExecutorEnv, Mode, PrivateKeys, RedisConfig } from ".";
import { ChainId } from "@certusone/wormhole-sdk";
import { dbg } from "../helpers/logHelper";

export async function loadUntypedEnvs(
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
      nodePath.join(dir, `${Mode.EXECUTOR.toLowerCase()}.json`)
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
      nodePath.join(dir, `${Mode.LISTENER.toLowerCase()}.json`)
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
    case ".yaml":
      return yaml.load(fileContent, {
        schema: yaml.JSON_SCHEMA,
      }) as Record<string, any>;
    case ".yml":
      return yaml.load(fileContent, {
        schema: yaml.JSON_SCHEMA,
      }) as Record<string, any>;
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
export function privateKeyEnvVarLoader(chains: ChainId[]): PrivateKeys {
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
