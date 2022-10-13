import { loadUntypedEnvs , loadFileAndParseToObject, Mode, NodeURI, validateStringEnum } from "relayer-engine";
import { EnvType } from "relayer-plugin-interface";


export async function loadPluginConfig(
  dir: string,
  pluginName: string,
  pluginURI: NodeURI,
  envType: EnvType
): Promise<Record<string, any>> {
  const overrides = loadFileAndParseToObject(
    `${dir}/plugins/${pluginName}.json`
  );
  const defaultConfig = loadFileAndParseToObject(
    `./node_modules/${pluginURI}/config/${envTypeToPath(envType)}.json`
  );
  return { ...(await defaultConfig), ...(await overrides) };
}


export function envTypeToPath(envType: EnvType): string {
  return envType.toLowerCase();
}

export async function loadUntypedEnvsDefault(): Promise<{
  mode: Mode;
  rawCommonEnv: any;
  rawListenerEnv: any;
  rawExecutorEnv: any;
}> {
  const modeString = process.env.MODE && process.env.MODE.toUpperCase();
  const envTypeString =
    process.env.ENV_TYPE && process.env.ENV_TYPE.toUpperCase();

  const mode = validateStringEnum<Mode>(Mode, modeString);
  const envType = validateStringEnum<EnvType>(
    EnvType,
    envTypeString ? envTypeString : EnvType.MAINNET
  );
  console.log(
    `Starting common config load for env: ${envTypeString}, mode: ${modeString}`
  );
  const dir = `./config/${envTypeToPath(envType)}`;
  return await loadUntypedEnvs(dir, mode, envType);
}
