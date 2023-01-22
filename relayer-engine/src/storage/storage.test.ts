import {
  ContractFilter,
  ParsedVaaWithBytes,
  StagingAreaKeyLock,
  Providers,
  Workflow,
  ActionExecutor,
} from "relayer-plugin-interface";
import { createLogger, transports } from "winston";
import { dbg, Plugin, sleep } from "..";
import { InMemory } from "./inMemoryStore";
import { DefaultStorage } from "./storage";

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
  consumeEvent(
    vaa: ParsedVaaWithBytes,
    stagingArea: StagingAreaKeyLock,
    providers: Providers,
  ): Promise<{ workflowData?: any }> {
    throw new Error("Method not implemented.");
  }
  handleWorkflow(
    workflow: Workflow<any>,
    providers: Providers,
    execute: ActionExecutor,
  ): Promise<void> {
    throw new Error("Method not implemented.");
  }
}

describe("Workflow lifecycle happy path tests using InMemory store", () => {
  const store = new InMemory();
  const plugin = new TestPlugin();
  const storage = new DefaultStorage(
    store,
    [plugin],
    { maxRetries: 10 },
    "test-id",
    createLogger({ transports: new transports.Console() }),
  );
  const workflow = {
    id: "id",
    pluginName: TestPlugin.pluginName,
    data: "This is some great data",
    retryCount: 0,
  };
  const key = workflowKey(workflow);

  it("adds workflows", async () => {
    await expect(await storage.numActiveWorkflows()).toBe(0);
    await storage.addWorkflow(workflow);
    const workflowAndPlugin = await storage.getWorkflow(workflow);
    expect(workflowAndPlugin).not.toBeNull();
    expect(workflowAndPlugin!.workflow).toEqual(workflow);
  });

  it("gets next workflow", async () => {
    const res = await storage.getNextWorkflow(2);
    await expect(res).toBeTruthy();
    expect(res!.workflow).toEqual(workflow);
    expect(await store.lLen("__activeWorkflows")).toBe(1);
    expect(await store.lIndex("__activeWorkflows", 0)).toBe(key);
  });

  it("completes workflow", async () => {
    await storage.completeWorkflow(workflow);
    expect(await store.hGet(key, "completedAt")).toBeTruthy();
    expect(await storage.numActiveWorkflows()).toBe(0);
    expect(await storage.numEnqueuedWorkflows()).toBe(0);
  });
});

describe("withKeys tests", () => {
  const store = new InMemory();
  const plugin = new TestPlugin();
  const logger = createLogger({ transports: new transports.Console() });
  const storage = new DefaultStorage(
    store,
    [plugin],
    { maxRetries: 10 },
    "test-node-id",
    logger,
  );
  const key = "key";

  const lock = storage.getStagingAreaKeyLock(plugin.pluginName);

  it("Should return 1", async () => {
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

  it("should not allow conflicting modifications ", async () => {
    const key = "key2";
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
    ).rejects.toThrow(Error);
    await expect(val).resolves.toBe(2);
    expect(await lock.getKeys([key])).toStrictEqual({ [key]: 2 });
  });
});

function workflowKey(workflow: { id: string; pluginName: string }): string {
  return `${workflow.pluginName}/${workflow.id}`;
}
