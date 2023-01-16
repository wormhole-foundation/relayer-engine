"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginEventSource = void 0;
const __1 = require("..");
const eventHarness_1 = require("./eventHarness");
class PluginEventSource {
    storage;
    providers;
    plugins;
    constructor(storage, plugins, providers) {
        this.storage = storage;
        this.providers = providers;
        this.plugins = new Map(plugins.map(p => [p.pluginName, p]));
    }
    getEventSourceFn(pluginName) {
        // is this necessary?
        const _this = this;
        return async (event, extraData) => {
            const plugin = (0, __1.nnull)(_this.plugins.get(pluginName));
            return await (0, eventHarness_1.consumeEventHarness)(event, plugin, _this.storage, _this.providers, extraData);
        };
    }
}
exports.PluginEventSource = PluginEventSource;
//# sourceMappingURL=pluginEventSource.js.map