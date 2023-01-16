import { EngineInitFn, Plugin } from "relayer-plugin-interface";
import { CommonEnv, ExecutorEnv, ListenerEnv, Mode } from "./config";
import { StoreType } from "./storage";
export * from "./config";
export * from "./utils/utils";
export * from "./storage";
export { getLogger, getScopedLogger, dbg, initLogger, } from "./helpers/logHelper";
export * from "relayer-plugin-interface";
export declare type CommonEnvRun = Omit<Omit<CommonEnv, "envType">, "mode">;
export interface RunArgs {
    configs: string | {
        commonEnv: CommonEnvRun;
        executorEnv?: ExecutorEnv;
        listenerEnv?: ListenerEnv;
    };
    mode: Mode;
    plugins: {
        fn: EngineInitFn<Plugin>;
        pluginName: string;
    }[];
    store?: StoreType;
}
export declare function run(args: RunArgs): Promise<void>;
