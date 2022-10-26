/*
 * Loads config files and env vars, resolves them into untyped objects
 */
// const configFile: string = process.env.SPY_RELAY_CONFIG
//   ? process.env.SPY_RELAY_CONFIG
//   : ".env.sample";
// console.log("loading config file [%s]", configFile);
// config({ path: configFile });
// export {};

import * as yaml from "js-yaml";
import * as fs from "fs";
import * as nodePath from "path";
import { EnvType as EnvType } from "relayer-plugin-interface";
import { Mode } from ".";

export async function loadUntypedEnvs(
  dir: string,
  mode: Mode,
  envType: EnvType
): Promise<{
  mode: Mode;
  rawCommonEnv: any;
  rawListenerEnv: any;
  rawExecutorEnv: any;
}> {
  const rawCommonEnv = await loadCommon(dir, mode);
  rawCommonEnv.envType = envType;
  rawCommonEnv.mode = mode;
  console.log("Successfully loaded the common config file.");

  const rawListenerEnv = await loadListener(dir, mode);
  const rawExecutorEnv = await loadExecutor(dir, mode);
  console.log("Successfully loaded the mode config file.");

  return {
    rawCommonEnv: rawCommonEnv,
    rawListenerEnv,
    rawExecutorEnv,
    mode,
  };
}

async function loadCommon(dir: string, mode: Mode): Promise<any> {
  const obj = await loadFileAndParseToObject(`${dir}/common.json`);
  obj.mode = mode;
  return obj;
}

async function loadExecutor(dir: string, mode: Mode): Promise<any> {
  if (mode == Mode.EXECUTOR || mode == Mode.BOTH) {
    return await loadFileAndParseToObject(
      `${dir}/${Mode.EXECUTOR.toLowerCase()}.json`
    );
  }
  return undefined;
}

async function loadListener(dir: string, mode: Mode): Promise<any> {
  if (mode == Mode.LISTENER || mode == Mode.BOTH) {
    return await loadFileAndParseToObject(
      `${dir}/${Mode.LISTENER.toLowerCase()}.json`
    );
  }
  return undefined;
}

// todo: extend to take path w/o extension and look for all supported extensions
export async function loadFileAndParseToObject(
  path: string
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
