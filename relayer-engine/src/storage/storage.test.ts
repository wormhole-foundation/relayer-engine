import RedisClient from "@node-redis/client/dist/lib/client";
import {
  ContractFilter,
  ParsedVaaWithBytes,
  StagingAreaKeyLock,
  Providers,
  Workflow,
  ActionExecutor,
} from "../../packages/relayer-plugin-interface";
import { createLogger, transports } from "winston";
import { dbg, IRedis, Plugin, sleep, minute } from "..";
import { RedisWrapper } from "./redisStore";
import { RedisClientType } from "redis";
import { Storage } from ".";

class TestPlugin implements Plugin {
  static pluginName: string = "TestPlugin";
  pluginName: string = TestPlugin.pluginName;
  pluginConfig: any;
  shouldSpy: boolean = true;
  shouldRest: boolean = false;
  demoteInProgress?: boolean | undefined;
  getFilters(): ContractFilter[] {
    throw new Error("Method not implemented.");
  }
  consumeEvent(): Promise<{ workflowData: any }> {
    throw new Error("Method not implemented.");
  }
  handleWorkflow(): Promise<void> {
    throw new Error("Method not implemented.");
  }
}

let redis: IRedis;
let store: RedisWrapper;
let storage: Storage;
const plugin = new TestPlugin();
const logger = createLogger({ transports: new transports.Console() });
const TEST_ID = "test-id";

describe("Storage tests", () => {
  beforeAll(async () => {
    store = await RedisWrapper.fromConfig({
      host: "localhost",
      port: 6301,
    });
    if (!store) {
      throw new Error("Could not conect to redis");
    }
    redis = store.redis;
    const _redis = redis as RedisClientType;
    const keys = await _redis.keys("*");
    if (keys.length !== 0) {
      throw new Error("Expected db to be empty, failing...");
    }
    storage = new Storage(
      store,
      [plugin],
      { maxRetries: 10 },
      TEST_ID,
      createLogger({ transports: new transports.Console() }),
    );
  });
  afterAll(async () => {
    const _redis = redis as RedisClientType;
    await _redis.flushDb();
    await _redis.quit();
    await new Promise(resolve => setImmediate(resolve));
  });

  describe("Workflow lifecycle happy path tests using InMemory store", () => {
    const workflow: Workflow<string> = {
      id: "special_id_11",
      pluginName: TestPlugin.pluginName,
      data: "This is some great data",
      retryCount: 0,
      maxRetries: 3,
      emitterAddress: "abc123",
      emitterChain: 1,
      sequence: "5",
      completedAt: undefined,
      failedAt: undefined,
      errorMessage: undefined,
      errorStacktrace: undefined,
      processingBy: "test-id",
    };
    const key = workflowKey(workflow);

    it("adds workflows", async () => {
      await expect(storage.numActiveWorkflows()).resolves.toBe(0);
      await storage.addWorkflow(workflow);
      const workflowAndPlugin = await storage.getWorkflow(workflow);
      expect(workflowAndPlugin).not.toBeNull();
      for (const [key, val] of Object.entries(workflow)) {
        // @ts-ignore
        expect(workflowAndPlugin!.workflow[key]).toEqual(val);
      }
      expect(
        workflowAndPlugin!.workflow.scheduledAt?.getTime(),
      ).toBeLessThanOrEqual(Date.now());
      expect(workflowAndPlugin!.workflow.scheduledBy).toEqual(TEST_ID);
    });

    it("gets next workflow", async () => {
      const res = await storage.getNextWorkflow(1);
      expect(res).toBeTruthy();
      logger.info(res);
      workflow.startedProcessingAt = res!.workflow.startedProcessingAt;
      expect(res!.workflow).toEqual(workflow);
      expect(await redis.lLen("__activeWorkflows")).toBe(1);
      expect(await redis.lIndex("__activeWorkflows", 0)).toBe(key);
    });

    it("completes workflow", async () => {
      await storage.completeWorkflow(workflow);
      expect(await redis.hGet(key, "completedAt")).toBeTruthy();
      expect(await storage.numActiveWorkflows()).toBe(0);
      expect(await storage.numEnqueuedWorkflows()).toBe(0);
    });
  });

  describe("withKeys tests", () => {
    const key = "key";
    let lock: StagingAreaKeyLock;
    it("Should return 1", async () => {
      lock = storage.getStagingAreaKeyLock(plugin.pluginName);
      const val = await lock.withKey([key], async kv => {
        return {
          newKV: {},
          val: 1,
        };
      });
      expect(val).toBe(1);
    });

    it("Should modify key", async () => {
      const val = await lock.withKey([key], async kv => {
        return {
          newKV: { [key]: 1 },
          val: 1,
        };
      });
      expect(await lock.getKeys([key])).toStrictEqual({ [key]: 1 });
    });

    it("Should modify key from 1 to 2", async () => {
      const val = await lock.withKey([key], async kv => {
        const newVal = kv[key] + 1;
        return {
          newKV: { [key]: newVal },
          val: newVal,
        };
      });
      expect(val).toBe(2);
      expect(await lock.getKeys([key])).toStrictEqual({ [key]: 2 });
    });

    xit("should not allow conflicting modifications ", async () => {
      const key = "key2";
      // this is the one that should fail (the one to finish last, not the one to withKey first).
      // Let's discuss how to fix, disabling test for now.
      const val = lock.withKey([key], async kv => {
        await sleep(500);
        const newval = 2;
        return {
          newKV: { [key]: newval },
          val: newval,
        };
      });
      await expect(
        lock.withKey([key], async kv => {
          const newval = 10;
          return {
            newKV: { [key]: newval },
            val: newval,
          };
        }),
      ).rejects.toThrow(Error); // the only reason this lock fails is because of how we're implementing watching, but it's not how redis does it. This is pessimistic whereas redis is optimistic.
      await expect(val).resolves.toBe(2);
      expect(await lock.getKeys([key])).toStrictEqual({ [key]: 2 });
    });
  });
});

function workflowKey(workflow: { id: string; pluginName: string }): string {
  return `${workflow.pluginName}/${workflow.id}`;
}
