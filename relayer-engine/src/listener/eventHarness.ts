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
import { fetchAndConsumeMissedVaas } from "./missedVaaFetching";

let _logger: ScopedLogger;
const logger = () => {
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
  try {
    receivedEventsCounter.labels({ plugin: plugin.pluginName }).inc();
    const parsedVaa = parseVaaWithBytes(vaa);
    const hash = parsedVaa.hash.toString("base64");
    const isInProgress = inProgress.get(hash);
    // if event is already being processed and processing started less than 5 minutes ago
    if (isInProgress && isInProgress > Date.now() - 5 * minute) {
      // skip
      logger().warn(
        `Attempted to process event, but id ${hash} already in progress, skipping...`,
        { id: hash },
      );
      return;
    }

    inProgress.set(hash, Date.now());
    const result = await plugin.consumeEvent(
      parsedVaa,
      storage.getStagingAreaKeyLock(plugin.pluginName),
      providers,
      extraData,
    );

    if (result && result.workflowData) {
      const { workflowData, workflowOptions } = result;
      logger().info(
        `Received workflow data from plugin ${plugin.pluginName}, adding workflow...`,
      );
      await storage.addWorkflow({
        data: workflowData,
        id: hash,
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
      plugin.pluginName,
      chainId,
      emitterAddress,
      Number(parsedVaa.sequence),
    );
    inProgress.delete(hash);
  } catch (e) {
    const l = logger();
    l.error(`Encountered error consumingEvent for plugin ${plugin.pluginName}`);
    l.error(e);
    erroredEventsCounter.labels({ plugin: plugin.pluginName }).inc();
  }
}
