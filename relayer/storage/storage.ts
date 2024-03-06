import { VAA } from "@wormhole-foundation/sdk";
import { Context } from "../context.js";

export interface StorageContext extends Context {
  storage: {
    job: RelayJob;
  };
}

export interface RelayJob {
  id: string;
  name: string;
  data: {
    vaaBytes: Uint8Array;
    parsedVaa: VAA<"Uint8Array">;
  };
  attempts: number;
  maxAttempts: number;
  receivedAt: number;

  log(logRow: string): Promise<number>;

  updateProgress(progress: number | object): Promise<void>;
}

export type onJobHandler = (job: RelayJob) => Promise<any>;

export interface Storage {
  addVaaToQueue(vaa: Uint8Array): Promise<RelayJob>;

  startWorker(cb: onJobHandler): void;

  stopWorker(): Promise<void>;
}
