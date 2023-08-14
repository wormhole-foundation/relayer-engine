import { jest, describe, test } from "@jest/globals";

import {
  ProcessVaaFn,
  runMissedVaaCheck,
  checkForMissedVaas,
} from "../../../relayer/middleware/missedVaasV3/check";
import {
  batchMarkAsSeen,
  batchMarkAsFailedToRecover,
  getAllProcessedSeqsInOrder,
  tryGetLastSafeSequence,
} from "../../../relayer/middleware/missedVaasV3/storage";
import { tryFetchVaa } from "../../../relayer/middleware/missedVaasV3/helpers";
import { Redis } from "ioredis";

jest.mock("../../../relayer/middleware/missedVaasV3/storage");
jest.mock("../../../relayer/middleware/missedVaasV3/helpers");

const batchMarkAsSeenMock = batchMarkAsSeen as jest.MockedFunction<
  typeof batchMarkAsSeen
>;
const batchMarkAsFailedToRecoverMock =
  batchMarkAsFailedToRecover as jest.MockedFunction<
    typeof batchMarkAsFailedToRecover
  >;
const getAllProcessedSeqsInOrderMock =
  getAllProcessedSeqsInOrder as jest.MockedFunction<
    typeof getAllProcessedSeqsInOrder
  >;

const tryGetLastSafeSequenceMock =
  tryGetLastSafeSequence as jest.MockedFunction<typeof tryGetLastSafeSequence>;

const tryFetchVaaMock = tryFetchVaa as jest.MockedFunction<typeof tryFetchVaa>;

describe("MissedVaaV3.check", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const redis = {};
  const processVaaMock = jest.fn() as jest.MockedFunction<ProcessVaaFn>;

  describe("checkForMissedVaas", () => {
    function prepareTest() {
      const emitterChain = 1;
      const emitterAddress = "foo";
      const opts = {
        storagePrefix: "bar",
        startingSequenceConfig: {},
      };

      return {
        opts,
        filter: { emitterChain, emitterAddress },
      };
    }

    /**
     * Leap Sequences:
     */

    test("If there are no seen sequences, no VAAs are tried to reprocess", async () => {
      const { opts, filter } = prepareTest();
      getAllProcessedSeqsInOrderMock.mockResolvedValue([]);

      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(processVaaMock).not.toHaveBeenCalled();
      expect(tryFetchVaaMock).not.toHaveBeenCalled();
    });

    test("If there are no leap sequences, no VAAs are tried to reprocess", async () => {
      const { opts, filter } = prepareTest();

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 2n, 3n]);

      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(processVaaMock).not.toHaveBeenCalled();

      // if there are seen sequences, look ahead will be ran
      expect(tryFetchVaaMock).toHaveBeenCalledTimes(1);
    });

    test("If there are leap sequences, they are tried to be reprocessed", async () => {
      const { opts, filter } = prepareTest();

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 2n, 5n, 8n, 13n]);

      const missingSequencesMock = [3n, 4n, 6n, 7n, 9n, 10n, 11n, 12n];

      missingSequencesMock.forEach(seq => {
        tryFetchVaaMock.mockResolvedValueOnce({
          vaaBytes: Buffer.from(seq.toString()),
        });
      });

      // look-ahead call
      tryFetchVaaMock.mockResolvedValue(null);

      const { processed } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(processVaaMock).toHaveBeenCalledTimes(missingSequencesMock.length);
      // + 1 because of the look-ahead call
      expect(tryFetchVaaMock).toHaveBeenCalledTimes(
        missingSequencesMock.length + 1,
      );
      expect(batchMarkAsSeenMock).toHaveBeenCalledTimes(1);
      expect(batchMarkAsFailedToRecoverMock).toHaveBeenCalledTimes(0);

      const markedSeen = batchMarkAsSeenMock.mock.calls[0][4];

      expect(processed.length).toEqual(missingSequencesMock.length);
      expect(markedSeen.length).toEqual(missingSequencesMock.length);

      missingSequencesMock.forEach(seq => {
        const seqStr = seq.toString();
        expect(markedSeen).toContain(seqStr);
        expect(processed).toContain(seqStr);
      });
    });

    test("If a sequence fails to be recovered it will be marked accordingly and won't interrupt the processing of other seqs", async () => {
      const { opts, filter } = prepareTest();

      // missing sequences are 2 and 4. Will force an error on seq 2 and expect seq 4
      // to have been processed anyway
      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 3n, 5n]);

      // cal for seq = 2
      tryFetchVaaMock.mockImplementationOnce((...args: any[]) => {
        throw new Error("foo");
      });

      tryFetchVaaMock.mockResolvedValueOnce({
        vaaBytes: Buffer.from("seq-4"),
      });

      const { processed, failedToRecover } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      // the two missing vaas + look-ahead call
      expect(tryFetchVaaMock).toHaveBeenCalledTimes(3);

      // only vaa 4 got to be processed
      expect(processVaaMock).toHaveBeenCalledTimes(1);

      // seq 2 failed to recover:
      expect(failedToRecover.length).toEqual(1);
      expect(batchMarkAsFailedToRecoverMock).toHaveBeenCalledTimes(1);

      const markedFailedToRecover =
        batchMarkAsFailedToRecoverMock.mock.calls[0][4];
      expect(markedFailedToRecover).toContain("2");
      expect(markedFailedToRecover.length).toEqual(1);

      // seq 4 was processed:
      expect(processed.length).toEqual(1);
      expect(batchMarkAsSeenMock).toHaveBeenCalledTimes(1);

      const markedSeen = batchMarkAsSeenMock.mock.calls[0][4];

      // VAAs marked as failed to recover are marked as seen
      expect(markedSeen.length).toEqual(2);
    });

    test("If a sequence fails to be reprocessed it won't be marked as seen and won't interrupt the processing of other seqs", async () => {
      const { opts, filter } = prepareTest();

      // missing sequences are 2 and 4. Will force an error on seq 2 and expect seq 4
      // to have been processed anyway
      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 3n, 5n]);

      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("seq-2") });
      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("seq-4") });
      tryFetchVaaMock.mockResolvedValueOnce(null); // look-ahead call.

      // first call will fail (Sequence 2)
      processVaaMock.mockImplementationOnce(async (...args: any[]) => {
        throw new Error("foo");
      });

      const { processed, failedToReprocess } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      // the two missing vaas + look-ahead call
      expect(tryFetchVaaMock).toHaveBeenCalledTimes(3);

      // both missing vaas were tried to process
      expect(processVaaMock).toHaveBeenCalledTimes(2);

      // seq 2 failed to recover:
      expect(failedToReprocess.length).toEqual(1);

      // failed to recover shouldn't be marked because we wan't to retry
      // them on the next run
      expect(batchMarkAsFailedToRecoverMock).toHaveBeenCalledTimes(0);

      // seq 4 was processed:
      expect(processed.length).toEqual(1);
      expect(batchMarkAsSeenMock).toHaveBeenCalledTimes(1);

      // only seq 4 should be marked as seen
      const markedSeen = batchMarkAsSeenMock.mock.calls[0][4];
      expect(markedSeen).toContain("4");

      // VAAs marked as failed to recover are marked as seen
      expect(markedSeen.length).toEqual(1);
    });

    /**
     * Look Ahead:
     */

    test("No seen sequences yet. If no startingSequence is configured, lookahead is not performed", async () => {
      const { opts, filter } = prepareTest();

      getAllProcessedSeqsInOrderMock.mockResolvedValue([]);
      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(processVaaMock).not.toHaveBeenCalled();
      expect(tryFetchVaaMock).toHaveBeenCalledTimes(0);
      expect(batchMarkAsSeenMock).not.toHaveBeenCalled();
      expect(batchMarkAsFailedToRecoverMock).not.toHaveBeenCalled();
    });

    test("No seen sequences yet. If a starting sequence is configured, it will perform lookahead from that sequence", async () => {
      const { opts, filter } = prepareTest();
      tryFetchVaaMock.mockResolvedValue(null);

      getAllProcessedSeqsInOrderMock.mockResolvedValue([]);
      const mockStartingSequence = 1n;
      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        {
          ...opts,
          startingSequenceConfig: {
            [filter.emitterChain]: mockStartingSequence,
          },
        },
      );

      expect(processVaaMock).not.toHaveBeenCalled();
      expect(batchMarkAsSeenMock).not.toHaveBeenCalled();
      expect(batchMarkAsFailedToRecoverMock).not.toHaveBeenCalled();

      expect(tryFetchVaaMock).toHaveBeenCalledTimes(1);

      const vaaSequenceFetched = tryFetchVaaMock.mock.calls[0][0].sequence;
      expect(vaaSequenceFetched).toEqual(mockStartingSequence.toString());
    });

    test("Seen sequences exist. it will start lookahead from the configured sequence if it's greater than the last seen seq", async () => {
      const { opts, filter } = prepareTest();
      tryFetchVaaMock.mockResolvedValue(null);

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 2n]);
      const mockStartingSequence = 5n;
      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        {
          ...opts,
          startingSequenceConfig: {
            [filter.emitterChain]: mockStartingSequence,
          },
        },
      );

      expect(processVaaMock).not.toHaveBeenCalled();
      expect(batchMarkAsSeenMock).not.toHaveBeenCalled();
      expect(batchMarkAsFailedToRecoverMock).not.toHaveBeenCalled();

      expect(tryFetchVaaMock).toHaveBeenCalledTimes(1);

      const vaaSequenceFetched = tryFetchVaaMock.mock.calls[0][0].sequence;
      expect(vaaSequenceFetched).toEqual(mockStartingSequence.toString());
    });

    test("Seen sequences exist. it will start lookahead from the last seen sequence +1 if it's greater than the configured sequence", async () => {
      const { opts, filter } = prepareTest();
      tryFetchVaaMock.mockResolvedValue(null);
      const seenSequencesMock = [1n, 2n, 3n, 4n, 5n, 6n];
      getAllProcessedSeqsInOrderMock.mockResolvedValue(seenSequencesMock);
      const mockStartingSequence = 5n;
      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        {
          ...opts,
          startingSequenceConfig: {
            [filter.emitterChain]: mockStartingSequence,
          },
        },
      );

      expect(processVaaMock).not.toHaveBeenCalled();
      expect(batchMarkAsSeenMock).not.toHaveBeenCalled();
      expect(batchMarkAsFailedToRecoverMock).not.toHaveBeenCalled();

      expect(tryFetchVaaMock).toHaveBeenCalledTimes(1);

      const vaaSequenceFetched = tryFetchVaaMock.mock.calls[0][0].sequence;
      const lastSeenSequence = seenSequencesMock[seenSequencesMock.length - 1];
      expect(vaaSequenceFetched).toEqual((lastSeenSequence + 1n).toString());
    });

    test("Look-Ahead will continue fetching VAAs until it gets a not found", async () => {
      const { opts, filter } = prepareTest();

      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("foo") });
      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("bar") });
      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("baz") });

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n]);

      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(tryFetchVaaMock).toHaveBeenCalledTimes(4);
      expect(processVaaMock).toHaveBeenCalledTimes(3);
    });

    test("It will add all found VAAs to the loadAheadSequences and processed stat", async () => {
      const { opts, filter } = prepareTest();

      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("foo") });
      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("bar") });
      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("baz") });

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n]);

      const { lookAheadSequences, processed } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(lookAheadSequences.length).toEqual(3);
      expect(processed.length).toEqual(3);
    });

    test("If processVaa throws is won't be added to processed list", async () => {
      const { opts, filter } = prepareTest();

      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("foo") });
      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("bar") });
      tryFetchVaaMock.mockResolvedValueOnce({ vaaBytes: Buffer.from("baz") });

      processVaaMock.mockResolvedValueOnce();
      processVaaMock.mockResolvedValueOnce();
      processVaaMock.mockRejectedValueOnce("foo");

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n]);

      const { lookAheadSequences, processed } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );

      expect(lookAheadSequences.length).toEqual(3);
      expect(processed.length).toEqual(2);
    });

    test("It doesn't throw if fetchVaa throws", async () => {
      const { opts, filter } = prepareTest();

      tryFetchVaaMock.mockImplementation((...args: any[]) => {
        throw new Error("foo");
      });

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n]);

      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
      );
    });
  });
});
