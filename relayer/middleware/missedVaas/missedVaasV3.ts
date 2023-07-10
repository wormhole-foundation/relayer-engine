import * as grpcWebNodeHttpTransport from "@improbable-eng/grpc-web-node-http-transport";
import Redis, { Cluster, RedisOptions } from "ioredis";
import { Registry, Counter, Histogram } from 'prom-client';
import { ChainId, getSignedVAAWithRetry } from "@certusone/wormhole-sdk";
import { GetSignedVAAResponse } from "@certusone/wormhole-sdk-proto-web/lib/cjs/publicrpc/v1/publicrpc";
import { createPool, Pool } from "generic-pool";

import { Context } from "../../context";
import {
  defaultWormholeRpcs,
  ParsedVaaWithBytes,
  RelayerApp,
  RelayerEvents,
} from "../../application";
import { Logger } from "winston";
import { mapConcurrent, minute, sleep } from "../../utils";
import { RedisConnectionOpts } from "../../storage/redis-storage";

const IN_PROGRESS_TIMEOUT = 5 * minute;

export type { RedisOptions };
export interface MissedVaaOpts extends RedisConnectionOpts {
  storagePrefix: string,
  registry?: Registry,
  logger?: Logger;
  wormholeRpcs?: string[];
  missedVaasConcurrency?: number;
  checkForMissedVaasEveryMs?: number;
}

export interface VaaKey {
  emitterChain: number;
  emitterAddress: string;
  seq: bigint;
}

interface FilterIndentifier {
  emitterChain: number,
  emitterAddress: string,
}

type FetchVaaFn = (vaa: VaaKey) => Promise<GetSignedVAAResponse>;
type ProcessVaaFn = (x: Buffer) => Promise<void>;
type TryFetchAndProcessFn = (
  redis: Redis | Cluster,
  vaaKey: VaaKey,
  logger?: Logger,
) => Promise<boolean>;

export function missedVaasV3(
  app: RelayerApp<any>,
  opts: MissedVaaOpts,
): void {
  opts.redis = opts.redis;
  opts.redis.keyPrefix = opts.namespace;
  opts.wormholeRpcs = opts.wormholeRpcs ?? defaultWormholeRpcs[app.env];

  const redisPool = createRedisPool(opts);

  const filters = app.filters.map((filter) => {
    return { 
      emitterChain: filter.emitterFilter.chainId,
      emitterAddress: filter.emitterFilter.emitterAddress
    };
  });

  startMissedVaasWorkers(filters, redisPool, opts);
}

async function startMissedVaasWorkers(
  filters: FilterIndentifier[],
  redisPool: Pool<Cluster | Redis>,
  opts: MissedVaaOpts,
) {
  const metrics: any = opts.registry ? initMetrics(opts.registry) : {};

  if (opts.storagePrefix) {
    await updateSeenSequences(filters, redisPool, opts);
  }

  console.log("RETURNING!")
  if (Math.random() < 1) return;
  while (true) {
    await mapConcurrent(filters, async filter => {
      const { emitterChain, emitterAddress } = filter;

      const startTime = Date.now();
      try {
        const vaasFound = await checkForMissedVaas(filter, redisPool, opts);
        if (vaasFound > 0) {
          metrics.recoveredVaas.labels({ emitterChain, emitterAddress }).inc(vaasFound);
        }
        metrics.workerSuccessfulRuns.labels({ emitterChain, emitterAddress }).inc();
      } catch (error) {
        opts.logger?.error(`Error checking for missed vaas for filter: ${
          JSON.stringify(filter)
        }. Error: ${error.toString()}`);
        metrics.workerFailedRuns.labels({ emitterChain, emitterAddress }).inc();
      } finally {
        const endTime = Date.now();

        metrics.workersRunDuration?.labels({ emitterChain, emitterAddress}).observe(endTime - startTime);
      }
    }, opts.missedVaasConcurrency || 1);

    // TODO: if possible handle this in a more event driven way (intervals + locks on a per chain basis)
    sleep(opts.checkForMissedVaasEveryMs || 30_000);
  }
}

async function updateSeenSequences(
  filters: FilterIndentifier[],
  redisPool: Pool<Cluster | Redis>,
  opts: MissedVaaOpts,
) {
  for (const filter of filters) {
    const { emitterChain, emitterAddress } = filter;
    opts.logger?.info(`Updating seen sequences for filter: ${emitterChain}/${emitterAddress}`);
    const redis = await redisPool.acquire();
    await scanNextBatchAndUpdateSeenSequences(redis, filter, opts.storagePrefix);
  }
}

const CURSOR_IDENTIFIER = '0';
async function scanNextBatchAndUpdateSeenSequences(
  redis: Redis | Cluster,
  filter: FilterIndentifier,
  storagePrefix: string,
  cursor = CURSOR_IDENTIFIER
) {
  const { emitterChain, emitterAddress } = filter;
  const prefix = `${storagePrefix}:${emitterChain}/${emitterAddress}`;
  const seenVaaKey = getSeenVaaKey(emitterChain, emitterAddress);

  const [nextCursor, keysFound] = await redis.scan(cursor, 'MATCH', `${prefix}*`);

  // const pipeline = redis.pipeline();

  for (const key of keysFound) {
    console.log("key found", key);
    const vaaSequence = parseStorageVaaKey(key);
    console.log("VAA SEQUENCE: ", vaaSequence);
    // pipeline.zadd(seenVaaKey, 0, vaaSequence);
  }

  // await pipeline.exec();

  if (nextCursor !== CURSOR_IDENTIFIER) {
    await scanNextBatchAndUpdateSeenSequences(redis, filter, storagePrefix, nextCursor);
  }
}

function parseStorageVaaKey (key: string) {
  const vaaIdString = key.split(':')[1];
  const sequenceString = vaaIdString.split('/')[2];
  return sequenceString;
}

function getSeenVaaKey(emitterChain: number, emitterAddress: string): string {
  return `missedVaasV3:seenVaas:${emitterChain}:${emitterAddress}`;
}

async function checkForMissedVaas(
  filter: FilterIndentifier,
  redisPool: Pool<Cluster | Redis>,
  opts: MissedVaaOpts,
): Promise<number> {
  let vaasFound = 0;
  const redis = await redisPool.acquire();
  // await redisPool.use(async (redis) => {
    // try get last safe sequence for chain.
    // if there is a safe sequence, start from there.
    // if there's not, get highest sequence from storage and start from there
    // else start from 0
    // the above number is going to get me the start of the range to check
    // const lastSafeSequence = await getLastSafeSequence(redis, filter) || 0;

    // const existingSequences = await getExistingSequencesForFilter(redis, filter, opts.storagePrefix);
    
    // const missedSequences = [];
    // let maxSafeSequence = null;
    // let lastSequenceSeen = null;
    // let lastSafeSequenceFound = null;
    // for (const sequence of existingSequences) {
    //   if (sequence <= lastSafeSequence) continue;
    //   if (lastSafeSequence === null) {
    //     lastSequenceSeen = sequence;
    //     continue;
    //   }

    //   if (sequence !== lastSequenceSeen + 1n) {

    //   }



    // }
    // get the highest sequence from storage
    // this is going to give the end of the range to check

    // check ranges

    // store the last safe sequence

    // check for sequences higher than the highest sequence in storage

    // if necessary, store the last safe sequence.

  // });

  return vaasFound;
}

export async function tryFetchAndProcess(
  processVaa: ProcessVaaFn,
  fetchVaa: FetchVaaFn,
  redis: Redis | Cluster,
  key: VaaKey,
  logger?: Logger,
): Promise<boolean> {
  try {
    const isInProgress = true // await fetchIsInProgress(redis, key, logger);
    if (isInProgress) {
      // short circuit if missedVaa middleware has already detected this vaa
      logger.warn("vaa in progress, skipping");
      return false;
    }

    // before re-triggering middleware, mark key as in progress to avoid recursion
    // await markInProgress(redis, key, logger);

    const fetchedVaa = await fetchVaa(key);
    logger?.info(
      `Possibly missed a vaa, adding to queue.`,
      vaaKeyReadable(key),
    );


    // push the missed vaa through all the middleware / storage service if used.
    processVaa(Buffer.from(fetchedVaa.vaaBytes));
    return true;
  } catch (e) {
    // code 5 means vaa not found in store
    if (e.code !== 5) {
      logger?.error(
        `Could not process missed vaa. Sequence: ${key.seq.toString()}`,
        e,
      );
    }
    return false;
  }
}

/*
 * Storage Helpers
 */

async function getExistingSequencesForFilter(
  redis: Redis | Cluster,
  { emitterChain, emitterAddress }: FilterIndentifier,
  storagePrefix: string,
): Promise<bigint[]> {
  const prefix = `${storagePrefix}:${emitterChain}/${emitterAddress}/*`;

  // keys are formed in the following way:
  // storagePrefix:emitterChain/emitterAddress/sequence/hash.substring(0,4)(:logs)?
  // (the keys that contain the :logs chunk are not workflow, they are workflow logs)
  const keys = await redis.keys(`${prefix}*`);

  return keys.map((key) => {
    const vaaIdString = key.split(':')[1];
    const sequenceString = vaaIdString.split('/')[2];
    return BigInt(sequenceString);
  }).sort();
}

function initMetrics(registry: Registry) {
  const workerFailedRuns = new Counter({
    name: "missed_vaas_failed_runs",
    help: "The number of runs that missed vaa worker didn't finish running due to an error",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const workerSuccessfulRuns = new Counter({
    name: "missed_vaas_successful_runs",
    help: "The number of runs that missed vaa worker finished without errors",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const recoveredVaas = new Counter({
    name: "missed_vaas_recovered",
    help: "The number of VAAs recovered by the missed-vaas worker",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
  });

  const workersRunDuration = new Histogram({
    name: "missed_vaas_worker_run_duration",
    help: "The duration of each of the worker runs",
    registers: [registry],
    labelNames: ["emitterChain", "emitterAddress"],
    buckets: [1000, 3000, 5000, 8000, 10000, 15000, 25000, 60000],
  });

  return {
    workerFailedRuns,
    workerSuccessfulRuns,
    recoveredVaas,
    workersRunDuration,
  };
}

/*
 * Utils
 */

export function createRedisPool(
  opts: RedisConnectionOpts,
): Pool<Redis | Cluster> {
  const factory = {
    create: async function () {
      const redis = opts.redisCluster
        ? new Redis.Cluster(opts.redisClusterEndpoints, opts.redisCluster)
        : new Redis(opts.redis);
      return redis;
    },
    destroy: async function (redis: Redis | Cluster) {
      // do something when destroyed?
    },
  };
  const poolOpts = {
    min: 5,
    max: 15,
    autostart: true,
  };
  return createPool(factory, poolOpts);
}

function vaaKeyReadable(key: VaaKey): {
  emitterAddress: string;
  emitterChain: string;
  sequence: string;
} {
  return {
    emitterAddress: key.emitterAddress,
    emitterChain: key.emitterChain.toString(),
    sequence: key.seq.toString(),
  };
}

async function fetchVaa(
  rpc: string[],
  { emitterChain, emitterAddress, seq }: VaaKey,
) {
  return await getSignedVAAWithRetry(
    rpc,
    emitterChain as ChainId,
    emitterAddress,
    seq.toString(),
    { transport: grpcWebNodeHttpTransport.NodeHttpTransport() },
    100,
    2,
  );
}
