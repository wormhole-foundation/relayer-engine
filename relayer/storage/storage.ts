import { Registry } from "prom-client";
import { Context } from "../context";
import { ParsedVaa, SignedVaa } from "@certusone/wormhole-sdk";

export interface StorageContext extends Context {
  storage: {
    job: RelayJob;
  };
}

export interface RelayJob {
  id: string;
  name: string;
  data: {
    vaaBytes: Buffer;
    parsedVaa: ParsedVaa;
  };
  attempts: number;
  maxAttempts: number;
  log(logRow: string): Promise<number>;
  updateProgress(progress: number | object): Promise<void>;
}

export type onJobHandler = (job: RelayJob) => Promise<any>;

export interface Storage {
  addVaaToQueue(vaa: SignedVaa): Promise<RelayJob>;
  startWorker(cb: onJobHandler): void;
  stopWorker(): Promise<void>;
}
