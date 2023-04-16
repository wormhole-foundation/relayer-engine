import { Job, Queue, Worker } from "bullmq";
import { ParsedVaa, parseVaa } from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import {
  Cluster,
  ClusterNode,
  ClusterOptions,
  Redis,
  RedisOptions,
} from "ioredis";
import { createStorageMetrics } from "../storage.metrics";
import { Gauge, Histogram, Registry } from "prom-client";
import { sleep } from "../utils";
import { onJobHandler, RelayJob, Storage } from "./storage";
import { KoaAdapter } from "@bull-board/koa";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";

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
    guardianSignatures: vaa.guardianSignatures.map(sig => ({
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

export class RedisStorage implements Storage {
  logger: Logger;
  vaaQueue: Queue<JobData, string[], string>;
  private worker: Worker<JobData, void, string>;
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

  workerId: string;

  constructor(opts: StorageOptions) {
    this.opts = Object.assign({}, defaultOptions, opts);
    // ensure redis is defined
    if (!this.opts.redis) {
      this.opts.redis = {};
    }

    this.opts.redis.maxRetriesPerRequest = null; //Added because of: DEPRECATION WARNING! Your redis options maxRetriesPerRequest must be null. On the next versions having this settings will throw an exception
    this.prefix = `{${this.opts.namespace ?? this.opts.queueName}}`;
    this.redis =
      this.opts.redisClusterEndpoints?.length > 0
        ? new Redis.Cluster(
            this.opts.redisClusterEndpoints,
            this.opts.redisCluster,
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

  async addVaaToQueue(vaaBytes: Buffer): Promise<RelayJob> {
    const parsedVaa = parseVaa(vaaBytes);
    const id = this.vaaId(parsedVaa);
    const idWithoutHash = id.substring(0, id.length - 6);
    this.logger?.debug(`Adding VAA to queue`, {
      emitterChain: parsedVaa.emitterChain,
      emitterAddress: parsedVaa.emitterAddress.toString("hex"),
      sequence: parsedVaa.sequence.toString(),
    });
    const job = await this.vaaQueue.add(
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
      },
    );

    return {
      attempts: 0,
      data: { vaaBytes, parsedVaa },
      id: job.id,
      name: job.name,
      log: job.log.bind(job),
      updateProgress: job.updateProgress.bind(job),
      maxAttempts: this.opts.attempts,
    };
  }

  private vaaId(vaa: ParsedVaa): string {
    const emitterAddress = vaa.emitterAddress.toString("hex");
    const hash = vaa.hash.toString("base64").substring(0, 5);
    let sequence = vaa.sequence.toString();
    return `${vaa.emitterChain}/${emitterAddress}/${sequence}/${hash}`;
  }

  startWorker(handleJob: onJobHandler) {
    this.logger?.debug(
      `Starting worker for queue: ${this.opts.queueName}. Prefix: ${this.prefix}.`,
    );
    this.worker = new Worker(
      this.opts.queueName,
      async job => {
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

        const vaaBytes = Buffer.from(job.data.vaaBytes, "base64");
        const relayJob: RelayJob = {
          attempts: job.attemptsMade,
          data: {
            vaaBytes,
            parsedVaa: parseVaa(vaaBytes),
          },
          id: job.id,
          maxAttempts: this.opts.attempts,
          name: job.name,
          log: job.log.bind(job),
          updateProgress: job.updateProgress.bind(job),
        };
        await job.log(`processing by..${this.workerId}`);
        await handleJob(relayJob);
        return;
      },
      {
        prefix: this.prefix,
        connection: this.redis,
        concurrency: this.opts.concurrency,
      },
    );
    this.workerId = this.worker.id;

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

  storageKoaUI(path: string) {
    // UI
    const serverAdapter = new KoaAdapter();
    serverAdapter.setBasePath(path);

    createBullBoard({
      queues: [new BullMQAdapter(this.vaaQueue)],
      serverAdapter: serverAdapter,
    });

    return serverAdapter.registerPlugin();
  }
}
