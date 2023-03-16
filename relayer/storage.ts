import { Job, Queue, Worker } from "bullmq";
import { ParsedVaa, parseVaa } from "@certusone/wormhole-sdk";
import { RelayerApp } from "./application";
import { Context } from "./context";
import { Logger } from "winston";
import { Cluster, ClusterNode, ClusterOptions, Redis, RedisOptions } from "ioredis";

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

export interface StorageContext extends Context {
  storage: {
    job: Job;
    worker: Worker;
  };
}

export interface StorageOptions {
  redisClusterEndpoints?: ClusterNode[];
  redisCluster?: ClusterOptions;
  redis?: RedisOptions;
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
  private redis: Cluster | Redis;

  constructor(private relayer: RelayerApp<T>, private opts: StorageOptions) {
    this.prefix = `{${opts.namespace ?? opts.queueName}}`;
    opts.redis = opts.redis || {};
    opts.redis.maxRetriesPerRequest = null; //Because of: DEPRECATION WARNING! Your redis options maxRetriesPerRequest must be null. On the next versions having this settings will throw an exception
    this.redis = opts.redisClusterEndpoints
      ? new Redis.Cluster(opts.redisClusterEndpoints, opts.redisCluster)
      : new Redis(opts.redis);
    this.vaaQueue = new Queue(opts.queueName, {
      prefix: this.prefix,
      connection: this.redis,
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
        attempts: this.opts.attempts,
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
      this.opts.queueName,
      async (job) => {
        await job.log(`processing by..${this.worker.id}`);
        let vaaBytes = Buffer.from(job.data.vaaBytes, "base64");
        await this.relayer.pushVaaThroughPipeline(vaaBytes, {
          storage: { job, worker: this.worker },
        });
        await job.updateProgress(100);
        return [""];
      },
      { prefix: this.prefix, connection: this.redis }
    );
  }
}
