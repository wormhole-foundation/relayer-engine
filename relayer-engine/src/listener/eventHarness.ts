import { SignedVaa } from "@certusone/wormhole-sdk";
import {
  ParsedVaaWithBytes,
  Plugin,
  Providers,
} from "../../packages/relayer-plugin-interface";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { Storage } from "../storage";
import {
  assertChainId,
  minute,
  parseVaaWithBytes,
  wormholeBytesToHex,
} from "../utils/utils";
import {
  createdWorkflowsCounter,
  erroredEventsCounter,
  receivedEventsCounter,
} from "./metrics";
import { randomUUID } from "crypto";

let _logger: ScopedLogger;
const harnessLogger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["eventHarness"]);
  }
  return _logger;
};

type VaaHash = string;
type Timestamp = number;
// todo: consider putting this into redis to support multi-node listeners
const inProgress = new Map<VaaHash, Timestamp>();

export async function consumeEventHarness(
  vaa: SignedVaa | ParsedVaaWithBytes,
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  extraData?: any[],
): Promise<void> {
  const parsedVaa = parseVaaWithBytes(vaa);
  const logger = harnessLogger().child({
    emitterChain: parsedVaa.emitterChain,
    emitterAddress: parsedVaa.emitterAddress,
    sequence: parsedVaa.sequence,
  });
  try {
    const hash = parsedVaa.hash.toString("base64");
    const isInProgress = inProgress.get(hash);
    // skip if event is already being processed and processing started less than 5 minutes ago
    if (isInProgress && isInProgress > Date.now() - 5 * minute) {
      logger.warn(
        `Attempted to process event, but id ${hash} already in progress, skipping...`,
        { id: hash },
      );
      return;
    }

    receivedEventsCounter.labels({ plugin: plugin.pluginName }).inc();

    inProgress.set(hash, Date.now());
    const result = await plugin.consumeEvent(
      parsedVaa,
      storage.getStagingAreaKeyLock(plugin.pluginName),
      providers,
      extraData,
    );

    if (result && result.workflowData) {
      const { workflowData, workflowOptions } = result;
      logger.info(
        `Received workflow data from plugin ${plugin.pluginName}, adding workflow...`,
      );
      const hashFirstDigits = parsedVaa?.hash.toString("hex").substring(0, 5);
      const emitterAddress = parsedVaa?.emitterAddress.toString("hex");
      const sequence = parsedVaa.sequence.toString();

      await storage.addWorkflow({
        data: workflowData,
        id: parsedVaa
          ? `${parsedVaa.emitterChain}/${emitterAddress}/${sequence}/${hashFirstDigits}`
          : randomUUID(),
        pluginName: plugin.pluginName,
        maxRetries: workflowOptions?.maxRetries ?? plugin.maxRetries,
        retryCount: 0,
        emitterChain: parsedVaa.emitterChain,
        emitterAddress: emitterAddress,
        sequence: sequence,
      });
      createdWorkflowsCounter.labels({ plugin: plugin.pluginName }).inc();
    }

    // update last seen sequence number for this emitter
    const chainId = assertChainId(parsedVaa.emitterChain);
    const emitterAddress = wormholeBytesToHex(parsedVaa.emitterAddress);
    await storage.setEmitterRecord(
      plugin.pluginName,
      chainId,
      emitterAddress,
      Number(parsedVaa.sequence),
    );
    inProgress.delete(hash);
  } catch (e) {
    logger.error(
      `Encountered error consumingEvent for plugin ${plugin.pluginName}`,
      e,
    );
    erroredEventsCounter.labels({ plugin: plugin.pluginName }).inc();
  }
}
