import { afterEach, describe, jest } from "@jest/globals";
import { RedisStorage } from "../relayer/storage/redis-storage.js";
import { VaaFactory } from "./vaa-factory.js";

jest.mock("ioredis", () => {
  const redis = class RedisMock {
    status: string = "ready";
    public on() {}
    public once() {}
    public defineCommand() {}
    public info() {
      return "redis_version:6.2.0";
    }
    public addJob() {}
  };
  const mockRedis = {
    Redis: redis,
    default: redis,
  };
  return mockRedis;
});

describe("redis-storage", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("addVaaToQueue", () => {
    it("should set backoff prop when exponentialBackoff option is present", async () => {
      const expectedAttempts = 10;
      const redisStorage = new RedisStorage({
        queueName: "queue",
        attempts: expectedAttempts,
        exponentialBackoff: { baseDelayMs: 10, maxDelayMs: 100 },
      });
      const addSpy = jest.spyOn(redisStorage.vaaQueue, "add");
      const result = await redisStorage.addVaaToQueue(VaaFactory.getVaa());
      expect(addSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ backoff: { type: "custom" } }),
      );
      expect(result).toHaveProperty("maxAttempts", expectedAttempts);
    });
  });
});
