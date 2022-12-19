import { getCommonEnv, getListenerEnv } from "../config";
import { getLogger, getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import {
  ContractFilter,
  ParsedVaaWithBytes,
  Plugin,
  Providers,
} from "relayer-plugin-interface";
import {
  createSpyRPCServiceClient,
  subscribeSignedVAA,
} from "@certusone/wormhole-spydk";
import { sleep } from "../utils/utils";
import { SpyRPCServiceClient } from "@certusone/wormhole-spydk/lib/cjs/proto/spy/v1/spy";
import { Storage } from "../storage";
import * as wormholeSdk from "@certusone/wormhole-sdk";
import { providersFromChainConfig } from "../utils/providers";
import LRUCache = require("lru-cache");
import { parseVaa } from "@certusone/wormhole-sdk";

let _logger: ScopedLogger;
const logger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["listenerHarness"]);
  }
  return _logger;
};
// TODO: get from config or sdk etc.
const NUM_GUARDIANS = 19;

export async function run(plugins: Plugin[], storage: Storage) {
  const listnerEnv = getListenerEnv();
  const commonEnv = getCommonEnv();
  const providers = providersFromChainConfig(commonEnv.supportedChains);

  //if spy is enabled, instantiate spy with filters
  if (shouldSpy(plugins)) {
    logger().info("Initializing spy listener...");
    const spyClient = createSpyRPCServiceClient(
      listnerEnv.spyServiceHost || "",
    );
    plugins.forEach(plugin => {
      if (plugin.shouldSpy) {
        logger().info(
          `Initializing spy listener for plugin ${plugin.pluginName}...`,
        );
        runPluginSpyListener(
          plugin,
          storage,
          spyClient,
          providers,
          commonEnv.numGuardians || NUM_GUARDIANS,
        );
      }
    });
  }

  //if rest is enabled, instantiate rest with filters
  if (shouldRest(plugins)) {
    //const restListener = setupRestListener(restFilters);
  }
  logger().debug("End of listener harness run function");
}

function shouldRest(plugins: Plugin[]): boolean {
  return plugins.some(x => x.shouldRest);
}

function shouldSpy(plugins: Plugin[]): boolean {
  return plugins.some(x => x.shouldSpy);
}

async function consumeEventHarness(
  vaa: Buffer,
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
): Promise<void> {
  try {
    const parsedVaa = parseVaa(vaa) as ParsedVaaWithBytes;
    parsedVaa.bytes = vaa;
    const { workflowData } = await plugin.consumeEvent(
      parsedVaa,
      storage.getStagingAreaKeyLock(plugin.pluginName),
      providers,
    );
    if (workflowData) {
      await storage.addWorkflow({
        data: workflowData,
        id: parsedVaa.hash.toString("base64"),
        pluginName: plugin.pluginName,
      });
    }
  } catch (e) {
    const l = logger();
    l.error(`Encountered error consumingEvent for plugin ${plugin.pluginName}`);
    l.error(JSON.stringify(e));
    // metric onError
  }
}

async function transformEmitterFilter(
  x: ContractFilter,
): Promise<ContractFilter> {
  return {
    chainId: x.chainId,
    emitterAddress: await encodeEmitterAddress(x.chainId, x.emitterAddress),
  };
}

async function encodeEmitterAddress(
  myChainId: wormholeSdk.ChainId,
  emitterAddressStr: string,
): Promise<string> {
  if (
    myChainId === wormholeSdk.CHAIN_ID_SOLANA ||
    myChainId === wormholeSdk.CHAIN_ID_PYTHNET
  ) {
    return await wormholeSdk.getEmitterAddressSolana(emitterAddressStr);
  }
  if (wormholeSdk.isTerraChain(myChainId)) {
    return await wormholeSdk.getEmitterAddressTerra(emitterAddressStr);
  }
  if (wormholeSdk.isEVMChain(myChainId)) {
    return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
  }
  throw new Error(`Unrecognized wormhole chainId ${myChainId}`);
}

//used for both rest & spy relayer for now
async function runPluginSpyListener(
  plugin: Plugin,
  storage: Storage,
  client: SpyRPCServiceClient,
  providers: Providers,
  numGuardians: number,
) {
  const vaaHashCache = new LRUCache({
    max: 10000,
  });
  while (true) {
    let stream: any;
    try {
      const rawFilters = plugin.getFilters();
      const filters = await Promise.all(
        rawFilters.map(async x => {
          return {
            emitterFilter: await transformEmitterFilter(x),
          };
        }),
      );
      logger().info(
        `${
          plugin.pluginName
        } subscribing to spy with raw filters: ${JSON.stringify(rawFilters)}`,
      );
      logger().debug(
        `${plugin.pluginName} using transformed filters: ${JSON.stringify(
          filters,
        )}`,
      );
      stream = await subscribeSignedVAA(client, {
        filters,
      });

      stream.on("data", (vaa: { vaaBytes: Buffer }) => {
        const parsed = wormholeSdk.parseVaa(vaa.vaaBytes);
        const hash = parsed.hash.toString("base64");
        logger().debug(hash);
        logger().debug(parsed.emitterChain);

        if (
          parsed.guardianSignatures.length < Math.ceil((numGuardians * 2) / 3)
        ) {
          logger().debug(
            `Encountered VAA without enough signatures: ${parsed.guardianSignatures.length}, ${hash}`,
          );
          return;
        }
        if (vaaHashCache.get(hash)) {
          logger().debug(`Duplicate founds for hash ${hash}`);
          return;
        }
        vaaHashCache.set(hash, true);
        consumeEventHarness(vaa.vaaBytes, plugin, storage, providers);
      });

      let connected = true;
      stream.on("error", (err: any) => {
        logger().error("spy service returned an error: %o", err);
        connected = false;
      });

      stream.on("close", () => {
        logger().error("spy service closed the connection!");
        connected = false;
      });

      logger().info(
        "connected to spy service, listening for transfer signed VAAs",
      );

      while (connected) {
        await sleep(1000);
      }
    } catch (e) {
      logger().error("spy service threw an exception: %o", e);
    }

    stream.destroy();
    await sleep(5 * 1000);
    logger().info("attempting to reconnect to the spy service");
  }
}
