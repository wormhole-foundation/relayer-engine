import { ChainId, SignedVaa } from "@certusone/wormhole-sdk";
import * as wh from "@certusone/wormhole-sdk";
import {
  ParsedVaaWithBytes,
  Plugin,
  Providers,
} from "relayer-plugin-interface";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { Storage } from "../storage";
import {
  assertChainId,
  parseVaaWithBytes,
  wormholeBytesToHex,
} from "../utils/utils";
import {
  createdWorkflowsCounter,
  erroredEventsCounter,
  receivedEventsCounter,
} from "./metrics";
import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";

const wormholeRpc = "https://wormhole-v2-testnet-api.certus.one";

let _logger: ScopedLogger;
const logger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["eventHarness"]);
  }
  return _logger;
};

async function fetchMissedVaas(
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  chainId: ChainId,
  emitterAddress: string,
  lastSeenSequence: number,
  latestSequence: number,
): Promise<void> {
  logger().debug(
    `Fetching missed vaas for ${chainId}:${emitterAddress}, from ${lastSeenSequence} to ${latestSequence}`,
  );
  for (let seq = lastSeenSequence + 1; seq < latestSequence; ++seq) {
    try {
      const resp = await wh.getSignedVAAWithRetry(
        [wormholeRpc],
        chainId,
        emitterAddress,
        seq.toString(),
        { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
      );

      if (!resp?.vaaBytes) {
        logger().debug(
          `Attempted to fetch vaa with lagging sequence number but not found in wormhole rpc. ${chainId}:${emitterAddress}:${seq}`,
        );
        continue;
      }
      consumeEventHarnessInner(resp.vaaBytes, plugin, storage, providers);
    } catch (e) {
      logger().error("Attempted to fetch missed Vaa but encountered error");
      logger().error(e);
    }
  }
}

export async function consumeEventHarness(
  vaa: SignedVaa,
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  extraData?: any[],
): Promise<void> {
  const parsedVaa = parseVaaWithBytes(vaa);

  const chainId = assertChainId(parsedVaa.emitterChain);
  const emitterAddress = wormholeBytesToHex(parsedVaa.emitterAddress);
  const emitterRecord = await storage.getEmitterRecord(chainId, emitterAddress);

  if (emitterRecord) {
    await fetchMissedVaas(
      plugin,
      storage,
      providers,
      chainId,
      emitterAddress,
      emitterRecord.lastSeenSequence,
      Number(parsedVaa.sequence),
    );
  }
  await consumeEventHarnessInner(vaa, plugin, storage, providers, extraData);
}

export async function consumeEventHarnessInner(
  vaa: SignedVaa | ParsedVaaWithBytes,
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  extraData?: any[],
): Promise<void> {
  try {
    receivedEventsCounter.labels({ plugin: plugin.pluginName }).inc();
    const parsedVaa = parseVaaWithBytes(vaa);
    const { workflowData, workflowOptions } = await plugin.consumeEvent(
      parsedVaa,
      storage.getStagingAreaKeyLock(plugin.pluginName),
      providers,
      extraData,
    );
    if (workflowData) {
      await storage.addWorkflow({
        data: workflowData,
        id: parsedVaa.hash.toString("base64"),
        pluginName: plugin.pluginName,
        maxRetries: workflowOptions?.maxRetries ?? plugin.maxRetries,
        retryCount: 0,
      });
      createdWorkflowsCounter.labels({ plugin: plugin.pluginName }).inc();
    }

    // update last seen sequence number for this emitter
    const chainId = assertChainId(parsedVaa.emitterChain);
    const emitterAddress = wormholeBytesToHex(parsedVaa.emitterAddress);
    await storage.setEmitterRecord(
      chainId,
      emitterAddress,
      Number(parsedVaa.sequence),
    );
  } catch (e) {
    const l = logger();
    l.error(`Encountered error consumingEvent for plugin ${plugin.pluginName}`);
    l.error(e);
    erroredEventsCounter.labels({ plugin: plugin.pluginName }).inc();
  }
}
