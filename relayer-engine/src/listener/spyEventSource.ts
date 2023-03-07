import {
  createSpyRPCServiceClient,
  subscribeSignedVAA,
} from "@certusone/wormhole-spydk";
import { SpyRPCServiceClient } from "@certusone/wormhole-spydk/lib/cjs/proto/spy/v1/spy";
import { Plugin, Providers } from "../../packages/relayer-plugin-interface";
import { Storage } from "../storage";
import { sleep } from "../utils/utils";
import * as wormholeSdk from "@certusone/wormhole-sdk";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { getCommonEnv, getListenerEnv } from "../config";
import { transformEmitterFilter } from "./listenerHarness";
import { consumeEventWithMissedVaaDetection } from "./missedVaaFetching";
import { spyConnectionsGauge } from "../metrics";
import LRUCache = require("lru-cache");

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
          logger().debug(`Received the same VAA more than once, skipping...`, {
            hash,
          });
          return;
        }
        vaaHashCache.set(hash, true);
        consumeEventWithMissedVaaDetection(
          vaa.vaaBytes,
          plugin,
          storage,
          providers,
        );
      });

      let connected = true;
      spyConnectionsGauge.inc(1);
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
      spyConnectionsGauge.dec(1); // only gets here if the connection drops. If it errors out and closes we don't want to decrement twice.
    } catch (e) {
      logger().error("spy service threw an exception: %o", e);
    }

    stream.destroy();
    await sleep(5 * 1000);
    logger().info("attempting to reconnect to the spy service");
  }
}
