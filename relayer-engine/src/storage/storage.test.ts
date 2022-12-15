import {
  ContractFilter,
  ParsedVaaWithBytes,
  StagingAreaKeyLock,
  Providers,
  Workflow,
  ActionExecutor,
} from "relayer-plugin-interface";
import { dbg, Plugin } from "..";
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

describe("Storage tests using InMemory store", () => {
  const store = new InMemory();
  const storage = new DefaultStorage(store, [new TestPlugin()]);
  const workflow = {
    id: "id",
    pluginName: TestPlugin.pluginName,
    data: "This is some great data",
  };
  const key = workflowKey(workflow);

  it("adds workflows", async () => {
    await expect(await storage.numActiveWorkflows()).toBe(0);
    await storage.addWorkflow(workflow);
    await expect(await store.get(key)).toStrictEqual(JSON.stringify(workflow));
  });


  // it("gets next workflow", async () => {
  //   const res = await storage.getNextWorkflow()
  //   await expect(res).toBeTruthy()

  // })
});

function workflowKey(workflow: { id: string; pluginName: string }): string {
  return `${workflow.pluginName}/${workflow.id}`;
}
