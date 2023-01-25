import { SignedVaa } from "@certusone/wormhole-sdk";
import { Plugin, Providers } from "relayer-plugin-interface";
import { Storage } from "../storage";
export declare function consumeEventHarness(vaa: SignedVaa, plugin: Plugin, storage: Storage, providers: Providers, extraData?: any[]): Promise<void>;
