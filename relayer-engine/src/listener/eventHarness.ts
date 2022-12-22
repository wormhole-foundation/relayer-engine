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

export async function consumeEventHarness(
  vaa: SignedVaa,
  plugin: Plugin,
  storage: Storage,
  providers: Providers,
): Promise<void> {
  try {
    const parsedVaa = parseVaaWithBytes(vaa);
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
