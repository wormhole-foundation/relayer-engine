"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = void 0;
const config_1 = require("../config");
const logHelper_1 = require("../helpers/logHelper");
const wormhole_spydk_1 = require("@certusone/wormhole-spydk");
const providers_1 = require("../utils/providers");
const spyEventSource_1 = require("./spyEventSource");
// TODO: get from config or sdk etc.
const NUM_GUARDIANS = 19;
let _logger;
const logger = () => {
    if (!_logger) {
        _logger = (0, logHelper_1.getScopedLogger)(["listenerHarness"]);
    }
    return _logger;
};
async function run(plugins, storage) {
    const listnerEnv = (0, config_1.getListenerEnv)();
    const commonEnv = (0, config_1.getCommonEnv)();
    const providers = (0, providers_1.providersFromChainConfig)(commonEnv.supportedChains);
    //if spy is enabled, instantiate spy with filters
    if (shouldSpy(plugins)) {
        logger().info("Initializing spy listener...");
        const spyClient = (0, wormhole_spydk_1.createSpyRPCServiceClient)(listnerEnv.spyServiceHost || "");
        plugins.forEach(plugin => {
            if (plugin.shouldSpy) {
                logger().info(`Initializing spy listener for plugin ${plugin.pluginName}...`);
                (0, spyEventSource_1.runPluginSpyListener)(plugin, storage, spyClient, providers, commonEnv.numGuardians || NUM_GUARDIANS);
            }
        });
    }
    //if rest is enabled, instantiate rest with filters
    if (shouldRest(plugins)) {
        //const restListener = setupRestListener(restFilters);
    }
    logger().debug("End of listener harness run function");
}
exports.run = run;
function shouldRest(plugins) {
    return plugins.some(x => x.shouldRest);
}
function shouldSpy(plugins) {
    return plugins.some(x => x.shouldSpy);
}
//# sourceMappingURL=listenerHarness.js.map