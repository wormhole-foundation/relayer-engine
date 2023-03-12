/// <reference types="node" />
import { ParsedVaa } from "@certusone/wormhole-sdk";
import { RelayerApp } from "./application";
export declare class Context {
    vaa?: ParsedVaa;
    vaaBytes?: Buffer;
    handleVaa: (vaa: Buffer) => void;
    constructor(app: RelayerApp<any>);
}
