/// <reference types="node" />
import { ParsedVaa } from "@certusone/wormhole-sdk";
import { Environment } from "./application";
import { Logger } from "winston";
import { ChainID } from "@certusone/wormhole-spydk/lib/cjs/proto/publicrpc/v1/publicrpc";
export interface Context {
    vaa?: ParsedVaa;
    vaaBytes?: Buffer;
    processVaa: (vaa: Buffer) => Promise<void>;
    env: Environment;
    logger?: Logger;
    config: {
        spyFilters: {
            emitterFilter?: {
                chainId?: ChainID;
                emitterAddress?: string;
            };
        }[];
    };
}
