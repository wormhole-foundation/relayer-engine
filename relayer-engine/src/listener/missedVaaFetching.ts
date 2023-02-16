import { ChainId, SignedVaa } from "@certusone/wormhole-sdk";
import * as wh from "@certusone/wormhole-sdk";
import { Plugin, Providers } from "../../packages/relayer-plugin-interface";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { Storage } from "../storage";
import {
  assertChainId,
  minute,
  parseVaaWithBytes,
  second,
  sleep,
  wormholeBytesToHex,
} from "../utils/utils";
import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import { transformEmitterFilter } from "./listenerHarness";
import { consumeEventHarness } from "./eventHarness";
import { getCommonEnv, getListenerEnv } from "../config";
import { time } from "console";

const DEFAULT_NEXT_VAA_FETCHING_WORKER_TIMEOUT_MS = 5 * minute;
const MIN_NEXT_VAA_FETCHING_WORKER_TIMEOUT_MS = 5 * second;

let _logger: ScopedLogger;
const logger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["missedVaaFetching"]);
  }
  return _logger;
};

export async function consumeEventWithMissedVaaDetection(
  vaa: SignedVaa,
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  extraData?: any[],
): Promise<void> {
  const parsedVaa = parseVaaWithBytes(vaa);

  const chainId = assertChainId(parsedVaa.emitterChain);
  const emitterAddress = wormholeBytesToHex(parsedVaa.emitterAddress);
  const emitterRecord = await storage.getEmitterRecord(
    plugin.pluginName,
    chainId,
    emitterAddress,
  );

  if (emitterRecord) {
    // this failing shouldn't block consumption of the vaa.
    try {
      await fetchAndConsumeMissedVaas(
        plugin,
        storage,
        providers,
        chainId,
        emitterAddress,
        emitterRecord.lastSeenSequence,
        Number(parsedVaa.sequence),
      );
    } catch (e) {
      if (e instanceof Error) {
        logger().error(`Attempting to fetch missed vaas failed: ${e.message}`);
        logger().error(e.stack);
      }
    }
  }
  await consumeEventHarness(vaa, plugin, storage, providers, extraData);
}

export async function nextVaaFetchingWorker(
  plugins: Plugin[],
  storage: Storage,
  providers: Providers,
) {
  logger().debug(`Grouping emitter keys from plugins...`);
  const pluginsAndFilters = await getEmitterKeys(plugins);

  logger().debug(`Starting nextVaaFetchingWorker...`);
  const timeout = getTimeout();

  while (true) {
    logger().debug(
      `Pessimistically fetching next vaa for all emitters registered by plugins`,
    );
    for (const key of pluginsAndFilters) {
      await tryFetchVaasForEmitter(key, storage, providers);
    }
    // wait 5 minutes between fetching next vaa
    logger().debug(
      `nextVaaFetchingWorker loop completed, sleeping ${timeout} ms...`,
    );
    await sleep(timeout);
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
      fetched = await tryFetchAndConsumeVaa(
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

async function tryFetchAndConsumeVaa(
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  chainId: ChainId,
  emitterAddress: string,
  sequence: number,
): Promise<boolean> {
  try {
    const resp = await wh.getSignedVAAWithRetry(
      [getCommonEnv().wormholeRpc],
      chainId,
      emitterAddress,
      sequence.toString(),
      { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
      100,
      2,
    );

    if (!resp?.vaaBytes) {
      logger().debug(
        `Attempted to fetch VAA but not found in wormhole rpc. ${chainId}:${emitterAddress}:${sequence.toString()}`,
      );
      return false;
    }
    consumeEventHarness(resp.vaaBytes, plugin, storage, providers);
    return true;
  } catch (e) {
    logger().error("Attempted to fetch VAA but encountered error");
    logger().error(e);
    return false;
  }
}

export async function fetchAndConsumeMissedVaas(
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
    const fetched = await tryFetchAndConsumeVaa(
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

function getEmitterKeys(plugins: Plugin[]): Promise<
  {
    plugin: Plugin;
    chainId: wh.ChainId;
    emitterAddress: string;
  }[]
> {
  const nestedEmitters = plugins.map(plugin => {
    const rawFilters = plugin.getFilters();
    return rawFilters.map(async x => {
      return {
        ...(await transformEmitterFilter(x)),
        plugin,
      };
    });
  });

  return Promise.all(nestedEmitters.flatMap(x => x));
}

function getTimeout(): number {
  const listenerEnv = getListenerEnv();
  if (listenerEnv.nextVaaFetchingWorkerTimeoutSeconds) {
    const configValue =
      listenerEnv.nextVaaFetchingWorkerTimeoutSeconds * second;
    if (configValue >= MIN_NEXT_VAA_FETCHING_WORKER_TIMEOUT_MS) {
      return configValue;
    }
    logger().warn(
      `nextVaaFetchingWorkerTimeoutSeconds must be at least ${Math.round(
        MIN_NEXT_VAA_FETCHING_WORKER_TIMEOUT_MS / second,
      )} seconds, found: ${listenerEnv.nextVaaFetchingWorkerTimeoutSeconds}`,
    );
    return MIN_NEXT_VAA_FETCHING_WORKER_TIMEOUT_MS;
  }
  return DEFAULT_NEXT_VAA_FETCHING_WORKER_TIMEOUT_MS * second;
}
