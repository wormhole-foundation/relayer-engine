import { Cluster, Redis } from 'ioredis'
import { createPool, Pool } from "generic-pool";
import { Logger } from 'winston';

import { SerializableVaaId } from "../../application";
import { RedisConnectionOpts } from "../../storage/redis-storage";
import { MissedVaaOpts, FilterIdentifier } from './worker'

export function createRedisPool(opts: RedisConnectionOpts): Pool<Redis | Cluster> {
  const factory = {
    create: async function () {
      const redis = opts.redisCluster
        ? new Redis.Cluster(opts.redisClusterEndpoints, opts.redisCluster)
        : new Redis(opts.redis);
      // TODO: metrics.missed_vaa_redis_open_connections.inc();
      return redis;
    },
    destroy: async function (redis: Redis | Cluster) {
      // TODO: metrics.missed_vaa_redis_open_connections.dec();
    },
  };
  const poolOpts = {
    min: 5,
    max: 15,
    autostart: true,
  };
  return createPool(factory, poolOpts);
}

export async function markVaaAsSeen(redis: Cluster | Redis, vaaKey: SerializableVaaId, opts: MissedVaaOpts) {
  const { emitterChain, emitterAddress, sequence } = vaaKey;
  const seenVaaKey = getSeenVaaKey(opts.storagePrefix, emitterChain, emitterAddress);
  const sequencesString = sequence.toString();
  await redis.zadd(seenVaaKey, sequencesString, sequencesString);
}

export function batchMarkAsSeen(
  redis: Cluster | Redis,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  sequences: string[]
) {
  return batchAddToSet(redis, getSeenVaaKey(prefix, emitterChain, emitterAddress), sequences);
}

export function batchMarkAsFailedToRecover(
  redis: Cluster | Redis,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  sequences: string[]
) {
  return batchAddToSet(redis, getFailedToFetchKey(prefix, emitterChain, emitterAddress), sequences);
}

export async function batchAddToSet(redis: Cluster | Redis, key: string, sequences: string[]) {
  const pipeline = redis.pipeline();

  for (const sequence of sequences) {
    pipeline.zadd(key, sequence, sequence);
  }

  await pipeline.exec();
}

export async function deleteExistingSeenVAAsData(
  filters: FilterIdentifier[],
  redisPool: Pool<Cluster | Redis>,
  opts: MissedVaaOpts,
) {
  opts.logger?.info("Deleting existing VAAs and failed VAAs. Will recreate index from redis-storage");
  
  const redis = await redisPool.acquire();

  const pipeline = redis.pipeline();

  for (const filter of filters) {
    pipeline.del(getSeenVaaKey(opts.storagePrefix, filter.emitterChain, filter.emitterAddress));
    pipeline.del(getFailedToFetchKey(opts.storagePrefix, filter.emitterChain, filter.emitterAddress));
    pipeline.del(getSafeSequenceKey(opts.storagePrefix, filter.emitterChain, filter.emitterAddress));
  }

  await pipeline.exec();

  redisPool.release(redis);
}

export async function updateSeenSequences(
  filters: FilterIdentifier[],
  redis: Redis | Cluster,
  storagePrefix: string,
) {
  let scannedKeys = 0;

  for (const filter of filters) {
    const seenVaaKey = getSeenVaaKey(
      storagePrefix,
      filter.emitterChain,
      filter.emitterAddress
    );

    scannedKeys += await scanNextBatchAndUpdateSeenSequences(redis, filter, storagePrefix, seenVaaKey);
  }

  return scannedKeys;
}

export async function trySetLastSafeSequence(
  redis: Redis | Cluster,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  lastSeenSequence: number,
  logger?: Logger,
) {
  const key = getSafeSequenceKey(prefix, emitterChain, emitterAddress);
  // since safe sequence is not critical, we'll swallow the error
  try {
    await redis.set(key, lastSeenSequence);
  } catch (error) {
    logger?.warn(`Error setting last safe sequence for chain: ${emitterChain}`, error);
    return false;
  }

  return true;
}

export async function tryGetLastSafeSequence(
  redis: Redis | Cluster,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  logger?: Logger,
): Promise<bigint|null> {
  // since safe sequence is not critical, we'll swallow the error
  const key = getSafeSequenceKey(prefix, emitterChain, emitterAddress);
  let lastSafeSequence: string;
  try {
    lastSafeSequence = await redis.get(key);
  } catch (error) {
    logger?.warn(`Error getting last safe sequence for chain: ${emitterChain}`, error);
    return null;
  }

  return lastSafeSequence ? BigInt(lastSafeSequence) : null;
}

export async function tryGetExistingFailedSequences(
  redis: Cluster | Redis,
  filter: FilterIdentifier,
  prefix: string,
) {
  const failedToFetchKey = getFailedToFetchKey(
    prefix,
    filter.emitterChain,
    filter.emitterAddress
  );

  let failedToFetchSequences
  
  try {
    failedToFetchSequences = await getDataFromSortedSet(redis, failedToFetchKey);
  } catch (error) {
    return error;
  }

  return failedToFetchSequences;
}

export async function calculateStartingIndex(
  redis: Redis | Cluster,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  lastSafeSequence?: bigint,
  startingSequence?: bigint,
  logger?: Logger,
) {
  const key = getSeenVaaKey(prefix, emitterChain, emitterAddress);

  let indexToStartFrom: number;

  if (!lastSafeSequence && startingSequence) {
    indexToStartFrom = await redis.zrank(key, startingSequence.toString());
    if (!indexToStartFrom) {
      logger.warn("Starting Sequence Config not found in redis. No starting sequence will be used.");
    }
  }
  
  else if (lastSafeSequence) {
    indexToStartFrom = await redis.zrank(key, lastSafeSequence.toString());
  }
  
  return indexToStartFrom;
}

export async function getAllProcessedSeqsInOrder(
  redis: Redis | Cluster,
  prefix: string,
  emitterChain: number,
  emitterAddress: string,
  indexToStartFrom?: number,
): Promise<bigint[]> {
  const key = getSeenVaaKey(prefix, emitterChain, emitterAddress);

  const results = await getDataFromSortedSet(redis, key, indexToStartFrom?.toString());
  return results.map(r => Number(r)).sort((a, b) => a - b).map(BigInt);
}

/**
 * 
 * Private Functions:
 * 
 */

function getSeenVaaKey(prefix: string, emitterChain: number, emitterAddress: string): string {
  return `${prefix}:missedVaasV3:seenVaas:${emitterChain}:${emitterAddress}`;
}

function getFailedToFetchKey(prefix: string, emitterChain: number, emitterAddress: string): string {
  return `${prefix}:missedVaasV3:failedToFetch:${emitterChain}:${emitterAddress}`;
}

function getSafeSequenceKey(prefix: string, emitterChain: number, emitterAddress: string): string {
  return `${prefix}:missedVaasV3:safeSequence:${emitterChain}:${emitterAddress}`;
}

// example keys:
// {GenericRelayer}:GenericRelayer-relays:14/000000000000000000000000306b68267deb7c5dfcda3619e22e9ca39c374f84/55/O8xvv:logs
// {GenericRelayer}:GenericRelayer-relays:14/000000000000000000000000306b68267deb7c5dfcda3619e22e9ca39c374f84/49/d1Cjd
function parseStorageVaaKey(key: string) {
  const vaaIdString = key.split(":")[2];
  const sequenceString = vaaIdString.split("/")[2];
  return sequenceString;
}

const CURSOR_IDENTIFIER = "0";
async function scanNextBatchAndUpdateSeenSequences(
  redis: Redis | Cluster,
  filter: FilterIdentifier,
  storagePrefix: string,
  seenVaaKey: string,
  cursor: string = CURSOR_IDENTIFIER,
): Promise<number> {
  const { emitterChain, emitterAddress } = filter;
  const prefix = `${storagePrefix}:${emitterChain}/${emitterAddress}`;
  const [nextCursor, keysFound] = await redis.scan(cursor, "MATCH", `${prefix}*`);

  const pipeline = redis.pipeline();
  let scannedKeys = 0;
  for (const key of keysFound) {
    scannedKeys++;
    if (key.endsWith(":logs")) continue;
    const vaaSequence = parseStorageVaaKey(key);
    pipeline.zadd(seenVaaKey, vaaSequence, vaaSequence);
  }

  await pipeline.exec();

  let nextBatchScannedKeys = 0;
  if (nextCursor !== CURSOR_IDENTIFIER) {
    nextBatchScannedKeys = await scanNextBatchAndUpdateSeenSequences(redis, filter, storagePrefix, seenVaaKey, nextCursor);
  }

  return scannedKeys + nextBatchScannedKeys;
}

function getDataFromSortedSet(redis: Redis | Cluster, key: string, lowerBound?: string) {
  const lb = lowerBound || '0';

  return redis.zrange(key, lb, -1);
}
