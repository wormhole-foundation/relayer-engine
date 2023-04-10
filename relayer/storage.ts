import { Job, Queue, Worker } from "bullmq";
import { ParsedVaa, parseVaa } from "@certusone/wormhole-sdk";
import { RelayerApp } from "./application";
import { Context } from "./context";
import { Logger } from "winston";
import {
  Cluster,
  ClusterNode,
  ClusterOptions,
  Redis,
  RedisOptions,
} from "ioredis";
import { createStorageMetrics } from "./storage.metrics";
import { Gauge, Histogram, Registry } from "prom-client";
import { sleep } from "./utils";

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
    maxAttempts: number;
  };
}

export interface StorageOptions {
  redisClusterEndpoints?: ClusterNode[];
  redisCluster?: ClusterOptions;
  redis?: RedisOptions;
  queueName: string;
  attempts: number;
  namespace?: string;
  concurrency?: number;
}

export type JobData = { parsedVaa: any; vaaBytes: string };

const defaultOptions: Partial<StorageOptions> = {
  attempts: 3,
  redis: {},
  queueName: "relays",
  concurrency: 3,
};

export class Storage<T extends Context> {
  logger: Logger;
  vaaQueue: Queue<JobData, string[], string>;
  private worker: Worker<JobData, string[], string>;
  private readonly prefix: string;
  private readonly redis: Cluster | Redis;
  public registry: Registry;
  private metrics: {
    delayedGauge: Gauge<string>;
    waitingGauge: Gauge<string>;
    activeGauge: Gauge<string>;
    completedDuration: Histogram<string>;
    processedDuration: Histogram<string>;
  };
  private opts: StorageOptions;

  constructor(private relayer: RelayerApp<T>, opts: StorageOptions) {
    this.opts = Object.assign({}, defaultOptions, opts);
    // ensure redis is defined 
    if (!this.opts.redis) {
      this.opts.redis = {};
    }

    this.opts.redis.maxRetriesPerRequest = null; //Added because of: DEPRECATION WARNING! Your redis options maxRetriesPerRequest must be null. On the next versions having this settings will throw an exception
    this.prefix = `{${this.opts.namespace ?? this.opts.queueName}}`;
    this.redis = this.opts.redisClusterEndpoints?.length > 0
      ? new Redis.Cluster(
          this.opts.redisClusterEndpoints,
          this.opts.redisCluster
        )
      : new Redis(this.opts.redis);
    this.vaaQueue = new Queue(this.opts.queueName, {
      prefix: this.prefix,
      connection: this.redis,
    });
    const { metrics, registry } = createStorageMetrics();
    this.metrics = metrics;
    this.registry = registry;
  }

  async addVaaToQueue(vaaBytes: Buffer) {
    const parsedVaa = parseVaa(vaaBytes);
    const id = this.vaaId(parsedVaa);
    const idWithoutHash = id.substring(0, id.length - 6);
    this.logger?.debug(`Adding VAA to queue`, {
      emitterChain: parsedVaa.emitterChain,
      emitterAddress: parsedVaa.emitterAddress.toString("hex"),
      sequence: parsedVaa.sequence.toString(),
    });
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
    this.logger?.debug(
      `Starting worker for queue: ${this.opts.queueName}. Prefix: ${this.prefix}.`
    );
    this.worker = new Worker(
      this.opts.queueName,
      async (job) => {
        let parsedVaa = job.data?.parsedVaa;
        if (parsedVaa) {
          this.logger?.debug(`Starting job: ${job.id}`, {
            emitterChain: parsedVaa.emitterChain,
            emitterAddress: parsedVaa.emitterAddress.toString("hex"),
            sequence: parsedVaa.sequence.toString(),
          });
        } else {
          this.logger.debug("Received job with no parsedVaa");
        }
        await job.log(`processing by..${this.worker.id}`);
        let vaaBytes = Buffer.from(job.data.vaaBytes, "base64");
        await this.relayer.pushVaaThroughPipeline(vaaBytes, {
          storage: {
            job,
            worker: this.worker,
            maxAttempts: this.opts.attempts,
          },
        });
        await job.updateProgress(100);
        return [""];
      },
      {
        prefix: this.prefix,
        connection: this.redis,
        concurrency: this.opts.concurrency,
      }
    );

    this.worker.on("completed", this.onCompleted.bind(this));
    this.spawnGaugeUpdateWorker();
  }

  async stopWorker() {
    await this.worker?.close();
    this.worker = null;
  }

  async spawnGaugeUpdateWorker(ms = 5000) {
    while (this.worker !== null) {
      await this.updateGauges();
      await sleep(ms);
    }
  }

  private async updateGauges() {
    const { active, delayed, waiting } = await this.vaaQueue.getJobCounts();
    this.metrics.activeGauge.labels({ queue: this.vaaQueue.name }).set(active);
    this.metrics.delayedGauge
      .labels({ queue: this.vaaQueue.name })
      .set(delayed);
    this.metrics.waitingGauge
      .labels({ queue: this.vaaQueue.name })
      .set(waiting);
  }

  private async onCompleted(job: Job) {
    const completedDuration = job.finishedOn! - job.timestamp!; // neither can be null
    const processedDuration = job.finishedOn! - job.processedOn!; // neither can be null
    this.metrics.completedDuration
      .labels({ queue: this.vaaQueue.name })
      .observe(completedDuration);
    this.metrics.processedDuration
      .labels({ queue: this.vaaQueue.name })
      .observe(processedDuration);
  }
}
