import { EventSource, Plugin, Providers, Storage } from "..";
export declare class PluginEventSource {
    readonly storage: Storage;
    readonly providers: Providers;
    plugins: Map<string, Plugin>;
    constructor(storage: Storage, plugins: Plugin[], providers: Providers);
    getEventSourceFn(pluginName: string): EventSource;
}
