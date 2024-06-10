import { jest, describe, test, afterEach, beforeEach } from "@jest/globals";

import {
  ProcessVaaFn,
  checkForMissedVaas,
} from "../../../relayer/middleware/missedVaasV3/check.js";
import {
  batchMarkAsSeen,
  batchMarkAsFailedToRecover,
  getAllProcessedSeqsInOrder,
} from "../../../relayer/middleware/missedVaasV3/storage.js";
import { tryFetchVaa } from "../../../relayer/middleware/missedVaasV3/helpers.js";
import { Redis } from "ioredis";
import {
  Wormholescan,
  WormholescanVaa,
} from "../../../relayer/rpc/wormholescan-client.js";
import { HttpClientError } from "../../../relayer/rpc/http-client.js";

jest.mock("../../../relayer/middleware/missedVaasV3/storage.js");
jest.mock("../../../relayer/middleware/missedVaasV3/helpers.js");

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

const tryFetchVaaMock = tryFetchVaa as jest.MockedFunction<typeof tryFetchVaa>;

let listVaaResponse: WormholescanVaa[] = [];

const failingWormscanClient: Wormholescan = {
  listVaas: jest.fn(() =>
    Promise.resolve({ data: [], error: new HttpClientError("foo") }),
  ),
  getVaa: jest.fn(() => Promise.resolve({ error: new HttpClientError("foo") })),
};

const workingWormscanClient: Wormholescan = {
  listVaas: jest.fn(() => Promise.resolve({ data: listVaaResponse })),
  getVaa: jest.fn(() => Promise.resolve({ data: listVaaResponse[0] })),
};

describe("MissedVaaV3.check", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  beforeEach(() => {
    listVaaResponse = [
      {
        id: "bar",
        sequence: 4n,
        vaa: Buffer.from("bar"),
        emitterAddr: "foo",
        emitterChain: 1,
      },
      {
        id: "baz",
        sequence: 3n,
        vaa: Buffer.from("baz"),
        emitterAddr: "foo",
        emitterChain: 1,
      },
      {
        id: "foo",
        sequence: 2n,
        vaa: Buffer.from("foo"),
        emitterAddr: "foo",
        emitterChain: 1,
      },
    ];
  });

  const redis = {};
  const processVaaMock = jest.fn() as jest.MockedFunction<ProcessVaaFn>;

  describe("checkForMissedVaas", () => {
    function prepareTest() {
      const emitterChain = 1;
      const emitterAddress = "foo";
      const prefix = "bar";
      const opts = {
        storagePrefix: prefix,
        startingSequenceConfig: {},
        maxLookAhead: 10,
        wormholeRpcs: [],
      };

      return {
        opts,
        filter: { emitterChain, emitterAddress },
        prefix,
      };
    }

    /**
     * Leap Sequences:
     */

    test("If there are no seen sequences, no VAAs are tried to reprocess", async () => {
      const { opts, filter, prefix } = prepareTest();
      getAllProcessedSeqsInOrderMock.mockResolvedValue([]);

      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        prefix,
        workingWormscanClient,
      );

      expect(processVaaMock).not.toHaveBeenCalled();
    });

    test("If there are no leap sequences, no VAAs are tried to reprocess", async () => {
      const { opts, filter, prefix } = prepareTest();
      listVaaResponse = [];
      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 2n, 3n]);

      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        prefix,
        workingWormscanClient,
      );

      expect(processVaaMock).not.toHaveBeenCalled();

      // if there are seen sequences, look ahead will be ran
    });

    test("If there are leap sequences, they are tried to be reprocessed", async () => {
      const { opts, filter, prefix } = prepareTest();

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 2n, 5n, 8n, 13n]);

      const missingSequencesMock = [3n, 4n, 6n, 7n, 9n, 10n, 11n, 12n];

      missingSequencesMock.forEach(seq => {
        tryFetchVaaMock.mockResolvedValueOnce(
          new Uint8Array(Buffer.from(seq.toString())),
        );
      });

      // look-ahead call
      tryFetchVaaMock.mockResolvedValue(null);

      const { processed } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        prefix,
        workingWormscanClient,
      );

      expect(processVaaMock).toHaveBeenCalledTimes(missingSequencesMock.length);
      expect(workingWormscanClient.listVaas).toHaveBeenCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({ pageSize: opts.maxLookAhead }),
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
      const { opts, filter, prefix } = prepareTest();

      // missing sequences are 2 and 4. Will force an error on seq 2 and expect seq 4
      // to have been processed anyway
      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 3n, 5n]);

      // cal for seq = 2
      tryFetchVaaMock.mockImplementationOnce((...args: any[]) => {
        throw new Error("foo");
      });

      tryFetchVaaMock.mockResolvedValueOnce(
        new Uint8Array(Buffer.from("seq-4")),
      );

      const { processed, failedToRecover } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        prefix,
        workingWormscanClient,
      );

      // the two missing vaas + look-ahead call
      expect(workingWormscanClient.listVaas).toHaveBeenCalledTimes(1);

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

      // VAAs marked as failed to recover are NOT marked as seen
      expect(markedSeen.length).toEqual(1);
    });

    test("If a sequence fails to be reprocessed it won't be marked as seen and won't interrupt the processing of other seqs", async () => {
      const { opts, filter, prefix } = prepareTest();

      // missing sequences are 2 and 4. Will force an error on seq 2 and expect seq 4
      // to have been processed anyway
      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 3n, 5n]);

      tryFetchVaaMock.mockResolvedValueOnce(
        new Uint8Array(Buffer.from("seq-2")),
      );
      tryFetchVaaMock.mockResolvedValueOnce(
        new Uint8Array(Buffer.from("seq-4")),
      );

      // first call will fail (Sequence 2)
      processVaaMock.mockImplementationOnce(async (...args: any[]) => {
        throw new Error("foo");
      });

      const { processed, failedToReprocess } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        prefix,
        workingWormscanClient,
      );

      // the two missing vaas
      expect(tryFetchVaaMock).toHaveBeenCalledTimes(2);

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
      const { opts, filter, prefix } = prepareTest();

      getAllProcessedSeqsInOrderMock.mockResolvedValue([]);
      await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        prefix,
        workingWormscanClient,
      );

      expect(processVaaMock).not.toHaveBeenCalled();
      expect(batchMarkAsSeenMock).not.toHaveBeenCalled();
      expect(workingWormscanClient.listVaas).not.toHaveBeenCalled();
    });

    test("No seen sequences yet. If a starting sequence is configured, it will perform lookahead from that sequence", async () => {
      const { opts, filter, prefix } = prepareTest();
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
        prefix,
        workingWormscanClient,
      );

      expect(processVaaMock).toHaveBeenCalledTimes(listVaaResponse.length);
      expect(batchMarkAsSeenMock).toHaveBeenCalled();
      expect(batchMarkAsFailedToRecoverMock).not.toHaveBeenCalled();

      expect(workingWormscanClient.listVaas).toHaveBeenCalledTimes(1);
    });

    test("Seen sequences exist. it will start lookahead from the configured sequence if it's greater than the last seen seq", async () => {
      const { opts, filter, prefix } = prepareTest();
      const mockStartingSequence = 5n;

      expect(listVaaResponse.length).toBeGreaterThan(0);
      expect(
        listVaaResponse.every(v => v.sequence <= mockStartingSequence),
      ).toBe(true);

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n, 2n]);

      listVaaResponse.push({
        id: "foo",
        sequence: mockStartingSequence + 1n,
        vaa: Buffer.from("foo"),
        emitterAddr: "foo",
        emitterChain: 1,
      });

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
        prefix,
        workingWormscanClient,
      );

      expect(processVaaMock).toHaveBeenCalledTimes(1);
    });

    test("Seen sequences exist. it will start lookahead from the last seen sequence +1 if it's greater than the configured sequence", async () => {
      const { opts, filter, prefix } = prepareTest();
      const seenSequencesMock = [1n, 2n, 3n, 4n, 5n, 6n];
      tryFetchVaaMock.mockResolvedValue(null);
      getAllProcessedSeqsInOrderMock.mockResolvedValue(seenSequencesMock);
      const mockStartingSequence = 5n;

      expect(listVaaResponse.length).toBeGreaterThan(0);
      expect(
        listVaaResponse.every(
          v => v.sequence <= seenSequencesMock[seenSequencesMock.length - 1],
        ),
      ).toBe(true);

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
        prefix,
        workingWormscanClient,
      );

      expect(workingWormscanClient.listVaas).toHaveBeenCalledTimes(1);

      expect(processVaaMock).not.toHaveBeenCalled();
      expect(batchMarkAsSeenMock).not.toHaveBeenCalled();
      expect(batchMarkAsFailedToRecoverMock).not.toHaveBeenCalled();
    });

    test("It will add all found VAAs to the loadAheadSequences and processed stat", async () => {
      const { opts, filter, prefix } = prepareTest();

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n]);

      const { lookAheadSequences, processed } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        prefix,
        workingWormscanClient,
      );

      expect(lookAheadSequences.length).toEqual(listVaaResponse.length);
      expect(processed.length).toEqual(listVaaResponse.length);
    });

    test("If processVaa throws is won't be added to processed list", async () => {
      const { opts, filter, prefix } = prepareTest();

      processVaaMock.mockResolvedValueOnce();
      processVaaMock.mockRejectedValueOnce("foo");

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n]);

      const { lookAheadSequences, processed } = await checkForMissedVaas(
        filter,
        redis as unknown as Redis,
        processVaaMock,
        opts,
        prefix,
        workingWormscanClient,
      );

      expect(lookAheadSequences.length).toEqual(listVaaResponse.length);
      expect(processed.length).toEqual(2);
    });

    test("It throws if listVaas throws", async () => {
      const { opts, filter, prefix } = prepareTest();

      getAllProcessedSeqsInOrderMock.mockResolvedValue([1n]);

      await expect(
        checkForMissedVaas(
          filter,
          redis as unknown as Redis,
          processVaaMock,
          opts,
          prefix,
          failingWormscanClient,
        ),
      ).rejects.toThrow("foo");
    });

    test("It reports failed to recover vaas found when a gap is found", async () => {
      const { opts, filter, prefix } = prepareTest();
      expect(listVaaResponse.length).toBeGreaterThan(0);
      const mockStartingSequence = listVaaResponse[0].sequence;

      getAllProcessedSeqsInOrderMock.mockResolvedValue([mockStartingSequence]);

      listVaaResponse.push({
        id: "foo",
        sequence: listVaaResponse[0].sequence + 2n, // skip one
        vaa: Buffer.from("foo"),
        emitterAddr: "foo",
        emitterChain: 1,
      });

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
        prefix,
        workingWormscanClient,
      );

      expect(processVaaMock).toHaveBeenCalledTimes(1);
      expect(batchMarkAsFailedToRecoverMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        [(mockStartingSequence + 1n).toString()],
      );
    });
  });
});
