import {
  createSpyRPCServiceClient,
  subscribeSignedVAA,
} from "@certusone/wormhole-spydk";
import { SpyRPCServiceClient } from "@certusone/wormhole-spydk/lib/cjs/proto/spy/v1/spy";
import LRUCache = require("lru-cache");
import { ContractFilter, Plugin, Providers } from "relayer-plugin-interface";
import { Storage } from "../storage";
import { sleep } from "../utils/utils";
import * as wormholeSdk from "@certusone/wormhole-sdk";
import { ScopedLogger, getScopedLogger } from "../helpers/logHelper";
import { consumeEventHarness } from "./eventHarness";
import { getCommonEnv, getListenerEnv } from "../config";
import { transformEmitterFilter } from "./listenerHarness";

// TODO: get from config or sdk etc.
const NUM_GUARDIANS = 19;

let _logger: ScopedLogger;
const logger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["spyEventSource"]);
  }
  return _logger;
};

export async function createSpyEventSource(
  plugins: Plugin[],
  storage: Storage,
  providers: Providers,
) {
  const commonEnv = getCommonEnv();
  const listenerEnv = getListenerEnv();
  const spyClient = createSpyRPCServiceClient(listenerEnv.spyServiceHost || "");
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
            `Encountered VAA without enough signatures: ${
              parsed.guardianSignatures.length
            }, need ${Math.ceil((numGuardians * 2) / 3)}, ${hash}`,
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
