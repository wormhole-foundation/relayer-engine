import { SpyRPCServiceClient } from "@certusone/wormhole-spydk/lib/cjs/proto/spy/v1/spy";
import { Plugin, Providers } from "relayer-plugin-interface";
import { Storage } from "../storage";
export declare function runPluginSpyListener(plugin: Plugin, storage: Storage, client: SpyRPCServiceClient, providers: Providers, numGuardians: number): Promise<void>;
