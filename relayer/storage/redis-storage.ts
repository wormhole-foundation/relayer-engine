import { Queue, Worker } from "bullmq";
import { Logger } from "winston";
import {
  Cluster,
  ClusterNode,
  ClusterOptions,
  Redis,
  RedisOptions,
} from "ioredis";
import { createStorageMetrics, StorageMetrics } from "../storage.metrics.js";
import { Registry } from "prom-client";
import { sleep } from "../utils.js";
import { onJobHandler, RelayJob, Storage } from "./storage.js";
import Koa from "koa";
import { KoaAdapter } from "@bull-board/koa";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { VAA, deserialize, encoding } from "@wormhole-foundation/sdk";

function serializeVaa(vaa: VAA<"Uint8Array">) {
  return {
    sequence: vaa.sequence.toString(),
    hash: encoding.b64.encode(vaa.hash),
    emitterChain: vaa.emitterChain,
    emitterAddress: vaa.emitterAddress.toString(),
    payload: encoding.b64.encode(vaa.payload),
    nonce: vaa.nonce,
    timestamp: vaa.timestamp,
    // TODO: ben
    // @ts-ignore
    version: vaa.version,
    guardianSignatures: vaa.signatures.map(sig => ({
      signature: encoding.b64.encode(sig.signature.encode()),
      index: sig.guardianIndex,
    })),
    consistencyLevel: vaa.consistencyLevel,
    guardianSetIndex: vaa.guardianSet,
  };
}

export interface RedisConnectionOpts {
  redisClusterEndpoints?: ClusterNode[];
  redisCluster?: ClusterOptions;
  redis?: RedisOptions;
  namespace?: string;
}

export interface ExponentialBackoffOpts {
  baseDelayMs: number; // amount of time to apply each exp. backoff round
  maxDelayMs: number; // max amount of time to wait between retries
  backOffFn?: (attemptsMade: number) => number; // custom backoff function
}

export interface StorageOptions extends RedisConnectionOpts {
  queueName: string;
  attempts: number;
  concurrency?: number;
  exponentialBackoff?: ExponentialBackoffOpts;
  maxCompletedQueueSize?: number;
  maxFailedQueueSize?: number;
}

export type JobData = { parsedVaa: any; vaaBytes: string };

const defaultOptions: Partial<StorageOptions> = {
  attempts: 3,
  redis: {},
  queueName: "relays",
  concurrency: 3,
  maxCompletedQueueSize: 10000,
  maxFailedQueueSize: 10000,
};

export class RedisStorage implements Storage {
  logger?: Logger;
  vaaQueue: Queue<JobData, string[], string>;
  public registry: Registry;
  workerId?: string;
  private worker?: Worker<JobData, void, string>;
  private readonly prefix: string;
  private readonly redis: Cluster | Redis;
  private metrics: StorageMetrics;
  private opts: StorageOptions;

  constructor(opts: StorageOptions) {
    this.opts = Object.assign({}, defaultOptions, opts);
    // ensure redis is defined
    if (!this.opts.redis) {
      this.opts.redis = {};
    }

    this.opts.redis.maxRetriesPerRequest = null; //Added because of: DEPRECATION WARNING! Your redis options maxRetriesPerRequest must be null. On the next versions having this settings will throw an exception
    this.prefix = `{${this.opts.namespace ?? this.opts.queueName}}`;
    this.redis =
      this.opts.redisClusterEndpoints !== undefined &&
      this.opts.redisClusterEndpoints.length > 0
        ? new Redis.Cluster(
            this.opts.redisClusterEndpoints,
            this.opts.redisCluster,
          )
        : new Redis(this.opts.redis);

    // TODO: consider using a queue per chain
    this.vaaQueue = new Queue(this.opts.queueName, {
      defaultJobOptions: {
        removeOnComplete: this.opts.maxCompletedQueueSize,
        removeOnFail: this.opts.maxFailedQueueSize,
      },
      prefix: this.prefix,
      connection: this.redis,
    });
    const { metrics, registry } = createStorageMetrics();
    this.metrics = metrics;
    this.registry = registry;
  }

  getPrefix() {
    return [this.prefix, this.opts.queueName].join(":");
  }

  async addVaaToQueue(vaaBytes: Buffer): Promise<RelayJob> {
    const startTime = Date.now();
    const parsedVaa = deserialize("Uint8Array", vaaBytes);
    const id = this.vaaId(parsedVaa);
    const idWithoutHash = id.substring(0, id.length - 6);
    this.logger?.debug(`Adding VAA to queue`, {
      emitterChain: parsedVaa.emitterChain,
      emitterAddress: parsedVaa.emitterAddress.toString(),
      sequence: parsedVaa.sequence.toString(),
    });
    const retryStrategy = this.opts.exponentialBackoff
      ? {
          backoff: {
            type: "custom",
          },
        }
      : undefined;

    const job = await this.vaaQueue.add(
      idWithoutHash,
      {
        parsedVaa: serializeVaa(parsedVaa),
        vaaBytes: vaaBytes.toString("base64"),
      },
      {
        jobId: id,
        removeOnFail: 50000,
        attempts: this.opts.attempts,
        ...retryStrategy,
      },
    );

    return {
      attempts: 0,
      data: { vaaBytes, parsedVaa: parsedVaa },
      id: job.id!,
      name: job.name,
      log: job.log.bind(job),
      receivedAt: startTime,
      updateProgress: job.updateProgress.bind(job),
      maxAttempts: this.opts.attempts,
    };
  }

  startWorker(handleJob: onJobHandler) {
    this.logger?.debug(
      `Starting worker for queue: ${this.opts.queueName}. Prefix: ${this.prefix}.`,
    );

    // Use user provided backoff function if available, otherwise use xlabs default
    let backOffFunction = undefined;
    if (this.opts.exponentialBackoff?.backOffFn) {
      backOffFunction = this.opts.exponentialBackoff.backOffFn;
    } else {
      backOffFunction = (attemptsMade: number) => {
        const exponentialDelay =
          Math.pow(2, attemptsMade) *
          (this.opts.exponentialBackoff?.baseDelayMs || 1000);
        return Math.min(
          exponentialDelay,
          this.opts.exponentialBackoff?.maxDelayMs || 3_600_000, // 1 hour as default
        );
      };
    }

    const workerSettings = this.opts.exponentialBackoff
      ? {
          settings: {
            backoffStrategy: backOffFunction,
          },
        }
      : undefined;

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
          this.logger?.debug("Received job with no parsedVaa");
        }

        const vaaBytes = Buffer.from(job.data.vaaBytes, "base64");
        const relayJob: RelayJob = {
          attempts: job.attemptsMade,
          data: {
            vaaBytes,
            parsedVaa: deserialize("Uint8Array", vaaBytes),
          },
          id: job.id!,
          maxAttempts: this.opts.attempts,
          name: job.name,
          receivedAt: job.timestamp,
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
        ...workerSettings,
      },
    );
    this.workerId = this.worker.id;

    this.spawnGaugeUpdateWorker();
  }

  async stopWorker() {
    await this.worker?.close();
    this.worker = undefined;
  }

  async spawnGaugeUpdateWorker(ms = 5000) {
    while (this.worker !== undefined) {
      await this.updateGauges();
      await sleep(ms);
    }
  }

  storageKoaUI(
    path: string,
  ): Koa.Middleware<Koa.DefaultState, Koa.DefaultContext, any> {
    // UI
    const serverAdapter = new KoaAdapter();
    serverAdapter.setBasePath(path);

    createBullBoard({
      queues: [new BullMQAdapter(this.vaaQueue)],
      serverAdapter: serverAdapter,
    });

    return serverAdapter.registerPlugin();
  }

  private vaaId(vaa: VAA<"Uint8Array">): string {
    const emitterAddress = vaa.emitterAddress.toString();
    const hash = encoding.b64.encode(vaa.hash).substring(0, 5);
    let sequence = vaa.sequence.toString();
    return `${vaa.emitterChain}/${emitterAddress}/${sequence}/${hash}`;
  }

  private async updateGauges() {
    const { active, delayed, waiting, failed } =
      await this.vaaQueue.getJobCounts();
    this.metrics.activeGauge.labels({ queue: this.vaaQueue.name }).set(active);
    this.metrics.delayedGauge
      .labels({ queue: this.vaaQueue.name })
      .set(delayed);
    this.metrics.waitingGauge
      .labels({ queue: this.vaaQueue.name })
      .set(waiting);
    this.metrics.failedGauge.labels({ queue: this.vaaQueue.name }).set(failed);
  }
}
