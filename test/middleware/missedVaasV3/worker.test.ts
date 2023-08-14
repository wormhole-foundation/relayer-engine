import { jest, describe, test } from "@jest/globals";

import {
  ProcessVaaFn,
  checkForMissedVaas,
} from "../../../relayer/middleware/missedVaasV3/check";
import {
  tryGetLastSafeSequence,
  trySetLastSafeSequence,
  tryGetExistingFailedSequences,
} from "../../../relayer/middleware/missedVaasV3/storage";
import { calculateSequenceStats } from "../../../relayer/middleware/missedVaasV3/helpers";
import { runMissedVaaCheck } from "../../../relayer/middleware/missedVaasV3/worker";

import { Redis } from "ioredis";
import { Logger } from "winston";

jest.mock("../../../relayer/middleware/missedVaasV3/storage");
jest.mock("../../../relayer/middleware/missedVaasV3/helpers");
jest.mock("../../../relayer/middleware/missedVaasV3/check");

const checkForMissedVaasMock = checkForMissedVaas as jest.MockedFunction<
  typeof checkForMissedVaas
>;

const tryGetLastSafeSequenceMock =
  tryGetLastSafeSequence as jest.MockedFunction<typeof tryGetLastSafeSequence>;

const trySetLastSafeSequenceMock =
  trySetLastSafeSequence as jest.MockedFunction<typeof trySetLastSafeSequence>;

const tryGetExistingFailedSequencesMock =
  tryGetExistingFailedSequences as jest.MockedFunction<
    typeof tryGetExistingFailedSequences
  >;

const calculateSequenceStatsMock =
  calculateSequenceStats as jest.MockedFunction<typeof calculateSequenceStats>;

describe("MissedVaaV3.worker", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const redis = {};
  const processVaaMock = jest.fn() as jest.MockedFunction<ProcessVaaFn>;

  describe("runMissedVaaCheck", () => {
    function prepareTest(overrides?: any) {
      const defaultResults = {
        processed: [],
        seenSequences: [],
        failedToRecover: [],
        failedToReprocess: [],
        lookAheadSequences: [],
        missingSequences: [],
        ...(overrides?.results ?? {}),
      };
      checkForMissedVaasMock.mockResolvedValue(defaultResults);

      const defaultSequenceStats = {
        lastSafeSequence: 0,
        lastSeenSequence: 0,
        firstSeenSequence: 0,
        ...(overrides?.sequenceStats ?? {}),
      };

      calculateSequenceStatsMock.mockReturnValue(defaultSequenceStats);

      const emitterChain = 1;
      const emitterAddress = "foo";

      const opts = {
        storagePrefix: "bar",
      };

      return { filter: { emitterChain, emitterAddress }, opts };
    }

    test("It runs missed vaa check", async () => {
      const { opts, filter } = prepareTest();

      await runMissedVaaCheck(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(checkForMissedVaasMock).toHaveBeenCalledTimes(1);
    });

    test("If a last safe sequence exists, it's used for the missed vaa check", async () => {
      const { opts, filter } = prepareTest();
      const mockSafeSequence = 5n;
      tryGetLastSafeSequenceMock.mockResolvedValue(mockSafeSequence);

      await runMissedVaaCheck(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(checkForMissedVaasMock).toHaveBeenCalledTimes(1);
      const args = checkForMissedVaasMock.mock.calls[0];
      expect(args[4]).toEqual(mockSafeSequence);
    });

    test("If there's not previous safe sequence, it will the lastSafeSequence as safe sequence", async () => {
      const safeSequenceMock = 100;
      const { opts, filter } = prepareTest({
        sequenceStats: { lastSafeSequence: safeSequenceMock },
      });

      await runMissedVaaCheck(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(trySetLastSafeSequenceMock).toHaveBeenCalledTimes(1);
      const args = trySetLastSafeSequenceMock.mock.calls[0];
      expect(args[4]).toEqual(safeSequenceMock);
    });

    test("If there's a previous safe sequence,  and it's different to the lastSafeSequence it will update the safe sequence", async () => {
      const previousSafeSequenceMock = 80n;
      tryGetLastSafeSequenceMock.mockResolvedValue(previousSafeSequenceMock);

      const safeSequenceMock = 100;
      const { opts, filter } = prepareTest({
        sequenceStats: { lastSafeSequence: safeSequenceMock },
      });

      await runMissedVaaCheck(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(trySetLastSafeSequenceMock).toHaveBeenCalledTimes(1);
      const args = trySetLastSafeSequenceMock.mock.calls[0];
      expect(args[4]).toEqual(safeSequenceMock);
    });

    test.only("If there's a previous safe sequence,  and it's the same to the lastSafeSequence it won't update the safe sequence", async () => {
      const previousSafeSequenceMock = 100n;
      tryGetLastSafeSequenceMock.mockResolvedValue(previousSafeSequenceMock);

      const safeSequenceMock = 100;
      const { opts, filter } = prepareTest({
        sequenceStats: { lastSafeSequence: safeSequenceMock },
      });

      await runMissedVaaCheck(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(trySetLastSafeSequenceMock).toHaveBeenCalledTimes(0);
    });

    test("If existing failed sequences exist, they are logged to the console", async () => {
      const { opts, filter } = prepareTest();

      const loggerMock = {
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      };

      const mockFailedSequences = ["1", "2", "3"];
      tryGetExistingFailedSequencesMock.mockResolvedValue(mockFailedSequences);

      await runMissedVaaCheck(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        loggerMock as unknown as Logger,
      );

      expect(loggerMock.warn).toHaveBeenCalledTimes(1);
      const args = loggerMock.warn.mock.calls[0];

      const logTemplate =
        `Found sequences that we failed to get from wormhole-rpc. Sequences: ` +
        JSON.stringify(mockFailedSequences);

      expect(args[0]).toEqual(logTemplate);
    });
  });
});
