import { jest, describe, test } from "@jest/globals";
import { Redis } from "ioredis";

import {
  deleteExistingSeenVAAsData,
  updateSeenSequences,
  trySetLastSafeSequence,
  tryGetLastSafeSequence,
  tryGetExistingFailedSequences,
  getAllProcessedSeqsInOrder,
  calculateStartingIndex,
} from "../../../relayer/middleware/missedVaasV3/storage";
import { Logger } from "winston";

describe("MissedVaaV3.storage", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("deleteExistingSeenVAAsData", () => {
    const pipeline = {
      del: jest.fn(),
      exec: jest.fn(),
    };

    const redis: any = {
      pipeline: jest.fn().mockImplementation(() => {
        return pipeline;
      }),
    };

    function prepareTest(overrides: any = {}) {
      const prefix = "foo";
      const emitterChain = "bar";
      const emitterAddress = "baz";

      return {
        prefix,
        emitterChain,
        emitterAddress,
        filters: [{ emitterAddress, emitterChain }],
        ...overrides,
      };
    }

    test("It removes all existing data on a single command roundtrip using pipeline", async () => {
      const { filters, prefix, emitterChain, emitterAddress } = prepareTest();

      await deleteExistingSeenVAAsData(filters, redis, prefix);

      expect(redis.pipeline).toHaveBeenCalledTimes(1);
      expect(pipeline.exec).toHaveBeenCalledTimes(1);
      expect(pipeline.del).toHaveBeenCalledTimes(3);
    });

    test("It throws if redis throws on exec", async () => {
      const { filters, prefix } = prepareTest();

      const errorMock = new Error("foo");
      pipeline.exec.mockImplementation(() => {
        throw errorMock;
      });

      await expect(
        deleteExistingSeenVAAsData(filters, redis, prefix),
      ).rejects.toThrow("foo");
    });
  });

  describe("scanNextBatchAndUpdateSeenSequences", () => {
    const pipeline = {
      zadd: jest.fn(),
      exec: jest.fn(),
    };

    const redis: any = {
      scan: jest.fn(),
      pipeline: jest.fn().mockImplementation(() => {
        return pipeline;
      }),
    };

    type ScanResult = [string, string[]];

    function prepareTest() {
      const prefix = "foo";
      const emitterAddress = "bar";
      const emitterChain = 1;

      function createSampleStorageKey(sequence: number | string) {
        return `${prefix}:${prefix}:${emitterChain}:${emitterAddress}:${sequence}/foo`;
      }

      function createLogsSampleKey(sequence: number | string) {
        return `${createSampleStorageKey(sequence)}:logs`;
      }

      function createScanResult(
        cursor: string,
        sequences: number[],
        includeLogs: boolean = false,
      ): ScanResult {
        const data = sequences.map(seq => createSampleStorageKey(seq));

        if (includeLogs) {
          data.push(...sequences.map(seq => createLogsSampleKey(seq)));
        }
        return [cursor, data];
      }

      return {
        prefix,
        emitterChain,
        emitterAddress,
        filters: [{ emitterAddress, emitterChain }],
        createSampleStorageKey,
        createLogsSampleKey,
        createScanResult,
      };
    }

    test("It scans all keys for the given filter using a prefix*", async () => {
      const {
        prefix,
        filters,
        emitterChain,
        emitterAddress,
        createScanResult,
      } = prepareTest();

      const scanFirstResult = createScanResult("0", []);
      redis.scan.mockResolvedValueOnce(scanFirstResult);

      await updateSeenSequences(filters, redis as unknown as Redis, prefix);

      expect(redis.scan).toHaveBeenCalledTimes(1);

      const args = redis.scan.mock.calls[0];

      expect(args[0]).toBe("0");
      expect(args[1]).toEqual("MATCH");
      expect(args[2]).toEqual(`${prefix}:${emitterChain}/${emitterAddress}*`);
    });

    test("It adds all found keys to the seen vaas sorted-set using zadd", async () => {
      const { prefix, filters, createScanResult } = prepareTest();

      const sequencesFound = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      redis.scan.mockResolvedValueOnce(createScanResult("0", sequencesFound));

      await updateSeenSequences(filters, redis as unknown as Redis, prefix);

      expect(pipeline.zadd).toHaveBeenCalledTimes(sequencesFound.length);
    });

    test("If it finds keys, it calls exec method on the pipeline", async () => {
      const { prefix, filters, createScanResult } = prepareTest();

      const sequencesFound = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      redis.scan.mockResolvedValueOnce(createScanResult("0", sequencesFound));

      await updateSeenSequences(filters, redis as unknown as Redis, prefix);

      expect(pipeline.exec).toHaveBeenCalledTimes(1);
    });

    test("it ignores results containing workflow logs", async () => {
      const { prefix, filters, createScanResult } = prepareTest();

      const sequencesFound = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      const createLogRecords = true;
      redis.scan.mockResolvedValueOnce(
        createScanResult("0", sequencesFound, createLogRecords),
      );

      await updateSeenSequences(filters, redis as unknown as Redis, prefix);

      expect(pipeline.zadd).toHaveBeenCalledTimes(sequencesFound.length);
    });

    test("It counts the scanned results and returns the count", async () => {
      const { prefix, filters, createScanResult } = prepareTest();

      redis.scan.mockResolvedValueOnce(createScanResult("6", [1, 2, 3]));
      redis.scan.mockResolvedValueOnce(createScanResult("3", [4, 5, 6]));
      redis.scan.mockResolvedValueOnce(createScanResult("0", [7, 8, 9]));

      const expectedResult = 9;

      const scanned = await updateSeenSequences(
        filters,
        redis as unknown as Redis,
        prefix,
      );

      expect(redis.scan).toHaveBeenCalledTimes(3);
      expect(scanned).toEqual(expectedResult);
    });
  });

  describe("trySetLastSafeSequence", () => {
    const redis = { set: jest.fn() };
    const logger = { warn: jest.fn() };

    function prepareTest(overrides: any = {}) {
      const prefix = "foo";
      const emitterChain = "bar";
      const emitterAddress = "baz";

      return {
        prefix,
        emitterChain,
        emitterAddress,
        ...overrides,
      };
    }

    test("It sets safe sequence to redis", async () => {
      const safeSequenceMock = 123;
      const { prefix, emitterChain, emitterAddress } = prepareTest();

      const res = await trySetLastSafeSequence(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        safeSequenceMock,
      );

      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(res).toEqual(true);

      const args = redis.set.mock.calls[0];

      expect(args[1]).toEqual(safeSequenceMock);
    });

    test("It returns false if redis throws", async () => {
      const { prefix, emitterChain, emitterAddress } = prepareTest();

      const errorMock = new Error("foo");

      redis.set.mockImplementation(() => {
        throw errorMock;
      });

      const res = await trySetLastSafeSequence(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        123,
        logger as unknown as Logger,
      );

      expect(redis.set).toHaveBeenCalledTimes(1);
      expect(res).toEqual(false);

      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe("tryGetLastSafeSequence", () => {
    const redis = { get: jest.fn() };

    function prepareTest(getResult?: string, overrides: any = {}) {
      redis.get.mockImplementation(async () => getResult || undefined);

      const prefix = "foo";
      const emitterChain = "bar";
      const emitterAddress = "baz";

      return {
        prefix,
        emitterChain,
        emitterAddress,
        ...overrides,
      };
    }

    test("It gets safe sequence from redis", async () => {
      const safeSequenceMock = "100";

      const { prefix, emitterChain, emitterAddress } =
        prepareTest(safeSequenceMock);

      const safeSequence = await tryGetLastSafeSequence(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
      );

      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(safeSequence).toEqual(BigInt(safeSequenceMock));
    });

    test("It returns null if there is no safe sequence on redis", async () => {
      const safeSequenceMock: undefined = undefined;

      const { prefix, emitterChain, emitterAddress } =
        prepareTest(safeSequenceMock);

      const safeSequence = await tryGetLastSafeSequence(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
      );

      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(safeSequence).toEqual(null);
    });

    test("It returns null if redis throws", async () => {
      const { prefix, emitterChain, emitterAddress } = prepareTest();
      const errorMock = new Error("foo");

      redis.get.mockImplementation(() => {
        throw errorMock;
      });

      const safeSequence = await tryGetLastSafeSequence(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
      );

      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(safeSequence).toEqual(null);
    });
  });

  describe("tryGetExistingFailedSequences", () => {
    const redis = { zrange: jest.fn() };

    function prepareTest(zrangeResult?: string[], overrides: any = {}) {
      redis.zrange.mockImplementation(async () => zrangeResult || []);

      const prefix = "foo";
      const emitterChain = "bar";
      const emitterAddress = "baz";
      const filter = { emitterChain, emitterAddress };

      return {
        prefix,
        filter,
        ...overrides,
      };
    }

    test("It gets the all data on the failed sorted set", async () => {
      const mockSeenVaas = ["1", "2", "3"];

      const { prefix, filter } = prepareTest(mockSeenVaas);

      const seenVaas = await tryGetExistingFailedSequences(
        redis as unknown as Redis,
        filter,
        prefix,
      );

      expect(redis.zrange).toHaveBeenCalledTimes(1);
      expect(seenVaas).toEqual(mockSeenVaas);

      const args = redis.zrange.mock.calls[0];
      expect(args[1]).toEqual(`0`);
    });

    test("If redis throws, the error is returned instead of thrown", async () => {
      const { prefix, filter } = prepareTest();

      const errorMock = new Error("foo");

      redis.zrange.mockImplementation(() => {
        throw errorMock;
      });

      const seenVaas = await tryGetExistingFailedSequences(
        redis as unknown as Redis,
        filter,
        prefix,
      );

      expect(redis.zrange).toHaveBeenCalledTimes(1);
      expect(seenVaas).toEqual(errorMock);
    });
  });

  describe("getAllProcessedSeqsInOrder", () => {
    const redis = { zrange: jest.fn() };

    function prepareTest(zrangeResult?: string[], overrides: any = {}) {
      redis.zrange.mockImplementation(async () => zrangeResult || []);

      const prefix = "foo";
      const emitterChain = "bar";
      const emitterAddress = "baz";
      const indexToStartFrom: undefined = undefined;

      return {
        prefix,
        emitterChain,
        emitterAddress,
        indexToStartFrom,
        ...overrides,
      };
    }

    test("It gets the seen vaas data from the redis sorted set, as bigint", async () => {
      const mockSeenVaas = ["1", "2", "3"];

      const { prefix, emitterChain, emitterAddress, indexToStartFrom } =
        prepareTest(mockSeenVaas);

      const seenVaas = await getAllProcessedSeqsInOrder(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        indexToStartFrom,
      );

      expect(redis.zrange).toHaveBeenCalledTimes(1);
      expect(seenVaas).toEqual(mockSeenVaas.map(BigInt));
    });

    test("It orders the seen vaas it returns", async () => {
      const mockSeenVaas = ["1", "3", "2"];

      const { prefix, emitterChain, emitterAddress, indexToStartFrom } =
        prepareTest(mockSeenVaas);

      const seenVaas = await getAllProcessedSeqsInOrder(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        indexToStartFrom,
      );

      expect(redis.zrange).toHaveBeenCalledTimes(1);

      const orderedVaas = mockSeenVaas.map(Number).sort();

      expect(seenVaas).toEqual(orderedVaas.map(BigInt));
    });

    test("It returns all seen vaas if not starting index is passed", async () => {
      // what we want to test is that it uses "0" as a lower bound to zrange
      // to command redis to return all VAAs.
      const { prefix, emitterChain, emitterAddress, indexToStartFrom } =
        prepareTest();

      const seenVaas = await getAllProcessedSeqsInOrder(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        indexToStartFrom,
      );

      expect(redis.zrange).toHaveBeenCalledTimes(1);

      const args = redis.zrange.mock.calls[0];
      expect(args[1]).toBe("0");
    });

    test("It returns vaas from a certain index is starting index is passed", async () => {
      const mockStartingIndex = 10n;

      const { prefix, emitterChain, emitterAddress, indexToStartFrom } =
        prepareTest(undefined, {
          indexToStartFrom: mockStartingIndex,
        });

      const seenVaas = await getAllProcessedSeqsInOrder(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        indexToStartFrom,
      );

      expect(redis.zrange).toHaveBeenCalledTimes(1);

      const args = redis.zrange.mock.calls[0];
      expect(args[1]).toBe(mockStartingIndex.toString());
    });
  });

  describe("calculateStartingIndex", () => {
    const redis = { zrank: jest.fn() };
    function prepareTest(redisSetIndex?: bigint, overrides: any = {}) {
      redis.zrank.mockImplementation(async () => redisSetIndex || undefined);

      const prefix = "foo";
      const emitterChain = "bar";
      const emitterAddress = "baz";
      const lastSafeSequence: undefined = undefined;
      const startingSequence: undefined = undefined;

      return {
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
        ...overrides,
      };
    }

    test("It returns undefined if there is no starting sequence nor safe sequence", async () => {
      const {
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
      } = prepareTest();

      const startingIndex = await calculateStartingIndex(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
      );

      expect(redis.zrank).not.toHaveBeenCalled();
      expect(startingIndex).toBeUndefined();
    });

    test("If there is a starting sequence but not a safe sequence, it will search the starting sequence on the seen sequences", async () => {
      const mockStartingIndex = 10n;
      const mockStartingSequence = 100n;

      const {
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
      } = prepareTest(mockStartingIndex, {
        startingSequence: mockStartingSequence,
      });

      const startingIndex = await calculateStartingIndex(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
      );

      expect(redis.zrank).toHaveBeenCalledTimes(1);
      // get arguments of redis.zrank first call
      const args = redis.zrank.mock.calls[0];
      expect(args[1]).toBe(mockStartingSequence.toString());

      expect(startingIndex).toBe(mockStartingIndex);
    });

    test("If there is a safe sequence it will use it to search for the starting index", async () => {
      const mockStartingIndex = 10n;
      const mockSafeSequence = 100n;

      const {
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
      } = prepareTest(mockStartingIndex, {
        lastSafeSequence: mockSafeSequence,
      });

      const startingIndex = await calculateStartingIndex(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
      );

      expect(redis.zrank).toHaveBeenCalledTimes(1);
      // get arguments of redis.zrank first call
      const args = redis.zrank.mock.calls[0];
      expect(args[1]).toBe(mockSafeSequence.toString());

      expect(startingIndex).toBe(mockStartingIndex);
    });

    test("If there is a safe sequence it will use it to search for the starting index, even if there is a startingSequence configuration", async () => {
      const mockStartingIndex = 100n;
      const mockSafeSequence = 101n;
      const mockStartingSequence = 102n;

      const {
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
      } = prepareTest(mockStartingIndex, {
        lastSafeSequence: mockSafeSequence,
        startingSequence: mockStartingSequence,
      });

      const startingIndex = await calculateStartingIndex(
        redis as unknown as Redis,
        prefix,
        emitterChain,
        emitterAddress,
        lastSafeSequence,
        startingSequence,
      );

      expect(redis.zrank).toHaveBeenCalledTimes(1);
      const args = redis.zrank.mock.calls[0];
      expect(args[1]).toBe(mockSafeSequence.toString());

      expect(startingIndex).toBe(mockStartingIndex);
    });
  });
});
