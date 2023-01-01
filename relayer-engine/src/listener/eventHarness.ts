import { Counter } from "prom-client";
import { SignedVaa } from "@certusone/wormhole-sdk";
import { Plugin, Providers } from "relayer-plugin-interface";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { Storage } from "../storage";
import { parseVaaWithBytes } from "../utils/utils";

let _logger: ScopedLogger;
const logger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["eventHarness"]);
  }
  return _logger;
};

const receivedEventsCounter = new Counter({
  name: "received_events_total",
  help: "Counter for number of events received by the listener",
  labelNames: ["plugin"],
});

const erroredEventsCounter = new Counter({
  name: "errored_events_total",
  help: "Counter for number of events that failed to be consumed (or add the workflow)",
  labelNames: ["plugin"],
});

const createdWorkflowsCounter = new Counter({
  name: "created_workflows_total",
  help: "Counter for number of created workflows by the listener",
  labelNames: ["plugin"],
});

export async function consumeEventHarness(
  vaa: SignedVaa,
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
  extraData?: any[],
): Promise<void> {
  try {
    receivedEventsCounter.labels({ plugin: plugin.pluginName }).inc();

    const parsedVaa = parseVaaWithBytes(vaa);
    const { workflowData } = await plugin.consumeEvent(
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
      });
      createdWorkflowsCounter.labels({ plugin: plugin.pluginName }).inc();
    }
  } catch (e) {
    const l = logger();
    l.error(`Encountered error consumingEvent for plugin ${plugin.pluginName}`);
    l.error(JSON.stringify(e));
    erroredEventsCounter.labels({ plugin: plugin.pluginName }).inc();
  }
}
