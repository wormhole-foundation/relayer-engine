import { ChainId } from "@certusone/wormhole-sdk";
import * as wh from "@certusone/wormhole-sdk";
import { Plugin, Providers } from "relayer-plugin-interface";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { Storage } from "../storage";
import { sleep } from "../utils/utils";
import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import { transformEmitterFilter } from "./listenerHarness";
import { consumeEventHarnessInner } from "./eventHarness";

const wormholeRpc = "https://wormhole-v2-testnet-api.certus.one";

let _logger: ScopedLogger;
const logger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["missedVaaFetching"]);
  }
  return _logger;
};

export async function nextVaaFetchingWorker(
  plugins: Plugin[],
  storage: Storage,
  providers: Providers,
) {
  logger().debug(`Grouping emitter keys from plugins...`);
  const pluginsAndFilters = await getEmitterKeys(plugins);

  logger().debug(`Starting nextVaaFetchingWorker...`);
  while (true) {
    logger().debug(
      `Pessimistically fetching next vaa for all emitters registered by plugins`,
    );
    for (const key of pluginsAndFilters) {
      await tryFetchVaasForEmitter(key, storage, providers);
    }
    // wait 5 minutes between fetching next vaa
    logger().debug(`nextVaaFetchingWorker loop completed, sleeping...`);
    await sleep(5 * 60_000);
  }
}

async function tryFetchVaasForEmitter(
  {
    plugin,
    chainId,
    emitterAddress,
  }: { plugin: Plugin; chainId: wh.ChainId; emitterAddress: string },
  storage: Storage,
  providers: Providers,
) {
  const record = await storage.getEmitterRecord(
    plugin.pluginName,
    chainId,
    emitterAddress,
  );

  if (record !== null) {
    let seq = record.lastSeenSequence + 1;
    for (let fetched = true; fetched; seq++) {
      fetched = await tryFetchVaa(
        plugin,
        storage,
        providers,
        chainId,
        emitterAddress,
        seq,
      );

      if (fetched) {
        logger().info(
          `Found vaa past last known sequence number, now fetching ${seq + 1}`,
        );
      }
    }
  }
}

async function tryFetchVaa(
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  chainId: ChainId,
  emitterAddress: string,
  sequence: number,
): Promise<boolean> {
  try {
    const resp = await wh.getSignedVAAWithRetry(
      [wormholeRpc],
      chainId,
      emitterAddress,
      sequence.toString(),
      { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
    );

    if (!resp?.vaaBytes) {
      logger().debug(
        `Attempted to fetch VAA but not found in wormhole rpc. ${chainId}:${emitterAddress}:${sequence.toString()}`,
      );
      return false;
    }
    consumeEventHarnessInner(resp.vaaBytes, plugin, storage, providers);
    return true;
  } catch (e) {
    logger().error("Attempted to fetch VAA but encountered error");
    logger().error(e);
    return false;
  }
}

export async function fetchMissedVaas(
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  chainId: ChainId,
  emitterAddress: string,
  lastSeenSequence: number,
  latestSequence: number,
): Promise<void> {
  logger().info(
    `Fetching missed vaas for ${chainId}:${emitterAddress}, from ${lastSeenSequence} to ${latestSequence}`,
  );
  for (let seq = lastSeenSequence + 1; seq < latestSequence; ++seq) {
    const fetched = await tryFetchVaa(
      plugin,
      storage,
      providers,
      chainId,
      emitterAddress,
      seq,
    );
    if (!fetched) {
      logger().warn(
        `Failed to fetch missed vaa ${chainId}:${emitterAddress}:${seq.toString()}`,
      );
    }
  }
}

async function getEmitterKeys(plugins: Plugin[]): Promise<
  {
    plugin: Plugin;
    chainId: wh.ChainId;
    emitterAddress: string;
  }[]
> {
  return await Promise.all(
    plugins.map(async plugin => {
      const rawFilters = plugin.getFilters();
      return await Promise.all(
        rawFilters.map(async x => {
          return {
            ...(await transformEmitterFilter(x)),
            plugin,
          };
        }),
      );
    }),
  ).then(x => x.flatMap(y => y));
}
