import * as wh from "@certusone/wormhole-sdk";
import { SignedVaa } from "@certusone/wormhole-sdk";
import { Queue } from "@datastructures-js/queue";
import { nnull, ParsedVaaWithBytes, Plugin, Providers, Storage } from "..";
import { consumeEventHarness } from "./eventHarness";

export class PluginEventSource {
  private static eventQueue = new Queue<{
    event: SignedVaa;
    pluginName: string;
  }>();
  private resources:
    | { storage: Storage; plugins: Map<string, Plugin>; providers: Providers }
    | undefined;

  constructor() {}

  async setStorageAndPlugins(
    storage: Storage,
    plugins: Plugin[],
    providers: Providers,
  ): Promise<void> {
    this.resources = {
      storage,
      plugins: new Map(plugins.map(p => [p.pluginName, p])),
      providers,
    };
    for (const {
      event,
      pluginName,
    } of PluginEventSource.eventQueue.toArray()) {
      const plugin = nnull(this.resources.plugins.get(pluginName));
      await consumeEventHarness(
        event,
        plugin,
        this.resources.storage,
        this.resources.providers,
      );
    }
  }

  getEventSourceFn(pluginName: string): (event: SignedVaa) => Promise<void> {
    // is this necessary?
    const _this = this;
    return async event => {
      if (!_this.resources) {
        PluginEventSource.eventQueue.push({ event, pluginName });
        return;
      }
      const plugin = nnull(_this.resources.plugins.get(pluginName));
      return await consumeEventHarness(
        event,
        plugin,
        _this.resources.storage,
        _this.resources.providers,
      );
    };
  }
}
