import { Job, Queue, Worker } from "bullmq";
import { ParsedVaa, parseVaa } from "@certusone/wormhole-sdk";
import { RelayerApp } from "./application";
import { Context } from "./context";
import { Logger } from "winston";

function serializeVaa(vaa: ParsedVaa) {
  return {
    sequence: vaa.sequence.toString(),
    hash: vaa.hash.toString("base64"),
    emitterChain: vaa.emitterChain,
    emitterAddress: vaa.emitterAddress.toString("hex"),
    payload: vaa.payload.toString("base64"),
    nonce: vaa.nonce,
    timestamp: vaa.timestamp,
    version: vaa.version,
    guardianSignatures: vaa.guardianSignatures.map((sig) => ({
      signature: sig.signature.toString("base64"),
      index: sig.index,
    })),
    consistencyLevel: vaa.consistencyLevel,
    guardianSetIndex: vaa.guardianSetIndex,
  };
}

function deserializeVaa(vaa: Record<string, any>): ParsedVaa {
  return {
    sequence: BigInt(vaa.sequence),
    hash: Buffer.from(vaa.hash, "base64"),
    emitterChain: vaa.emitterChain,
    emitterAddress: Buffer.from(vaa.emitterAddress, "hex"),
    payload: Buffer.from(vaa.payload, "base64"),
    nonce: vaa.nonce,
    timestamp: vaa.timestamp,
    version: vaa.version,
    guardianSignatures: vaa.guardianSignatures.map((sig: any) => ({
      signature: Buffer.from(sig.signature, "base64"),
      index: sig.index,
    })),
    consistencyLevel: vaa.consistencyLevel,
    guardianSetIndex: vaa.guardianSetIndex,
  };
}

export class StorageContext extends Context {
  job: Job;
}

export interface StorageOptions {
  queueName: string;
  attempts: number;
  namespace?: string;
  // redis:
}

export type JobData = { parsedVaa: any; vaaBytes: string };

export class Storage<T extends Context> {
  logger: Logger;
  vaaQueue: Queue<JobData, string[], string>;
  private worker: Worker<JobData, string[], string>;
  private prefix: string;

  constructor(
    private relayer: RelayerApp<T>,
    private storageOptions: StorageOptions
  ) {
    this.prefix = `{${storageOptions.namespace ?? storageOptions.queueName}}`;
    this.vaaQueue = new Queue(storageOptions.queueName, {
      prefix: this.prefix,
    });
  }

  async addVaaToQueue(vaaBytes: Buffer) {
    const parsedVaa = parseVaa(vaaBytes);
    const id = this.vaaId(parsedVaa);
    const idWithoutHash = id.substring(0, id.length - 6);
    return this.vaaQueue.add(
      idWithoutHash,
      {
        parsedVaa: serializeVaa(parsedVaa),
        vaaBytes: vaaBytes.toString("base64"),
      },
      {
        jobId: id,
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: this.storageOptions.attempts,
      }
    );
  }

  private vaaId(vaa: ParsedVaa): string {
    const emitterAddress = vaa.emitterAddress.toString("hex");
    const hash = vaa.hash.toString("base64").substring(0, 5);
    let sequence = vaa.sequence.toString();
    return `${vaa.emitterChain}/${emitterAddress}/${sequence}/${hash}`;
  }

  startWorker() {
    this.worker = new Worker(
      this.storageOptions.queueName,
      async (job) => {
        await job.log(`processing by..${this.worker.id}`);
        let vaaBytes = Buffer.from(job.data.vaaBytes, "base64");
        await this.relayer.handleVaa(vaaBytes);
        await job.updateProgress(100);
        return [""];
      },
      { prefix: this.prefix }
    );
  }
}
