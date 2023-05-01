import {
  jest,
  describe,
  test,
  beforeAll,
  afterAll,
  beforeEach,
} from "@jest/globals";
import {
  MissedVaaOpts,
  VaaKey,
  createRedisPool,
  markProcessed,
  missedVaaJob,
} from "./carefulMissedVaas.middleware";
import { CHAIN_ID_AVAX } from "@certusone/wormhole-sdk";
import { GetSignedVAAResponse } from "@certusone/wormhole-sdk-proto-web/lib/cjs/publicrpc/v1/publicrpc";
import { Redis } from "ioredis";
import { EngineError, sleep } from "../utils";
import { createLogger, format, transports, Logger } from "winston";

const logger = createLogger({
  level: "debug",
  transports: new transports.Console({ format: format.simple() }),
});

const opts: MissedVaaOpts = {
  redis: {
    host: "localhost",
    port: 6301,
  },
};

type ProcessVaaFn = (x: Buffer) => Promise<void>;
type FetchVaaFn = (vaa: VaaKey) => Promise<GetSignedVAAResponse>;
type TryFetchAndProcessFn = (
  redis: Redis,
  vaaKey: VaaKey,
  logger?: Logger,
) => Promise<boolean>;

const emitterAddress = "0xEF179777F69cE855718Df64E2E84BBA99b6E4828";
const emitterAddressOther = "0xAF179777F69cE855718Df64E2E84BBA99b6E4827";

describe("missed vaa job", () => {
  // @ts-ignore
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(opts.redis);
  });

  afterAll(() => redis.disconnect());

  beforeEach(() => redis.flushall());

  test("simple", async () => {
    const emitterChain = CHAIN_ID_AVAX;
    const filters = [
      {
        emitterFilter: {
          chainId: emitterChain,
          emitterAddress,
        },
      },
    ];
    const makeVaaKey = (seq: bigint) => ({ emitterAddress, emitterChain, seq });

    const signed = [1n, 2n, 5n, 7n, 8n];
    const seen = [0n, 3n, 4n, 6n];

    // mark processed
    await Promise.all(
      seen.map(seq => markProcessed(redis, makeVaaKey(seq), logger)),
    );

    const tryFetchAndProcess = jest.fn(
      async (redis: Redis, vaaKey: VaaKey, logger?: Logger) => {
        return signed.includes(vaaKey.seq);
      },
    );

    await missedVaaJob(redis, filters, tryFetchAndProcess, logger);
    expect(tryFetchAndProcess).toBeCalledTimes(6);
    const results = Promise.all(
      tryFetchAndProcess.mock.results.map(r => r.value),
    );
    expect(results).resolves.toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      false
    ]);
  });

  test("tryFetchAndProcess", async () => {
    // mocks
    const fetchVaa: FetchVaaFn = jest.fn(async (vaaKey: VaaKey) => {
      if (true) {
        return { vaaBytes: new Uint8Array([Number(vaaKey.seq)]) };
      }
      throw vaaNotFound();
    });
    const processVaa: ProcessVaaFn = jest.fn(async (vaa: Buffer) =>
      Promise.resolve(),
    );
    
  })

  test("two runs", async () => {
    const emitterChain = CHAIN_ID_AVAX;
    const filters = [
      {
        emitterFilter: {
          chainId: emitterChain,
          emitterAddress,
        },
      },
    ];
    const makeVaaKey = (seq: bigint) => ({ emitterAddress, emitterChain, seq });

    let signed = [0n, 1n, 2n, 3n, 6n, 8n];
    let seen = [0n, 3n, 6n];

    // mark processed
    await Promise.all(
      seen.map(seq => markProcessed(redis, makeVaaKey(seq), logger)),
    );

    // mocks
    const fetchVaa: FetchVaaFn = jest.fn(async (vaaKey: VaaKey) => {
      if (signed.includes(vaaKey.seq)) {
        return { vaaBytes: new Uint8Array([Number(vaaKey.seq)]) };
      }
      throw vaaNotFound();
    });
    const processVaa: ProcessVaaFn = jest.fn(async (vaa: Buffer) =>
      Promise.resolve(),
    );

    // await missedVaaJob(redis, filters, processVaa, fetchVaa, logger);
    await sleep(100);
    expect(fetchVaa).toBeCalledTimes(5);
    expect(processVaa).toBeCalledTimes(2);

    logger.info("Job run #2");

    signed.push(5n, 6n, 7n);
    // await missedVaaJob(redis, filters, processVaa, fetchVaa, logger);
    await sleep(100);
    expect(fetchVaa).toBeCalledTimes(6);
    expect(processVaa).toBeCalledTimes(5);
  });
});

const vaaNotFound = () => {
  let e = new Error("vaa not found") as any;
  e.code = 5;
  return e;
};
