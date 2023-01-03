import { EventSource, nnull, Plugin, Providers, Storage } from "..";
import { consumeEventHarness } from "./eventHarness";

export class PluginEventSource {
  plugins: Map<string, Plugin>;

  constructor(
    readonly storage: Storage,
    plugins: Plugin[],
    readonly providers: Providers,
  ) {
    this.plugins = new Map(plugins.map(p => [p.pluginName, p]));
  }

  getEventSourceFn(pluginName: string): EventSource {
    // is this necessary?
    const _this = this;
    return async (event, extraData) => {
      const plugin = nnull(_this.plugins.get(pluginName));
      return await consumeEventHarness(
        event,
        plugin,
        _this.storage,
        _this.providers,
        extraData,
      );
    };
  }
}
