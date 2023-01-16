"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.consumeEventHarness = void 0;
const logHelper_1 = require("../helpers/logHelper");
const utils_1 = require("../utils/utils");
const metrics_1 = require("./metrics");
let _logger;
const logger = () => {
    if (!_logger) {
        _logger = (0, logHelper_1.getScopedLogger)(["eventHarness"]);
    }
    return _logger;
};
async function consumeEventHarness(vaa, plugin, storage, providers, extraData) {
    try {
        metrics_1.receivedEventsCounter.labels({ plugin: plugin.pluginName }).inc();
        const parsedVaa = (0, utils_1.parseVaaWithBytes)(vaa);
        const { workflowData, workflowOptions } = await plugin.consumeEvent(parsedVaa, storage.getStagingAreaKeyLock(plugin.pluginName), providers, extraData);
        if (workflowData) {
            await storage.addWorkflow({
                data: workflowData,
                id: parsedVaa.hash.toString("base64"),
                pluginName: plugin.pluginName,
                maxRetries: workflowOptions?.maxRetries ?? plugin.maxRetries,
                retryCount: 0,
            });
            metrics_1.createdWorkflowsCounter.labels({ plugin: plugin.pluginName }).inc();
        }
    }
    catch (e) {
        const l = logger();
        l.error(`Encountered error consumingEvent for plugin ${plugin.pluginName}`);
        l.error(e);
        metrics_1.erroredEventsCounter.labels({ plugin: plugin.pluginName }).inc();
    }
}
exports.consumeEventHarness = consumeEventHarness;
//# sourceMappingURL=eventHarness.js.map