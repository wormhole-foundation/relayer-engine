import { ParsedVaa } from "@certusone/wormhole-sdk";
import { RelayerApp } from "./application";

export class Context {
  vaa?: ParsedVaa;
  vaaBytes?: Buffer;
  handleVaa: (vaa: Buffer) => void;

  constructor(app: RelayerApp<any>) {
    this.handleVaa = app.handleVaa;
  }
}
