import {
  ActionExecutor,
  assertArray,
  CommonEnv,
  CommonPluginEnv,
  ContractFilter,
  dbg,
  EngineInitFn,
  ParsedVaaWithBytes,
  Plugin,
  PluginDefinition,
  Providers,
  sleep,
  StagingArea,
  StagingAreaKeyLock,
  Workflow,
} from "relayer-engine";
import * as wh from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import { assertBool } from "./utils";
import { ChainId, ParsedVaa, parseVaa } from "@certusone/wormhole-sdk";
import { stringify } from "querystring";

export interface DummyPluginConfig {
  spyServiceFilters: { chainId: wh.ChainId; emitterAddress: string }[];
  shouldRest: boolean;
  shouldSpy: boolean;
}

interface WorkflowPayload {
  vaa: string; // base64
  count: number;
}

interface WorkflwoPayloadDeserialized {
  vaa: ParsedVaaWithBytes;
  count: number;
}

export class DummyPlugin implements Plugin<WorkflowPayload> {
  readonly shouldSpy: boolean;
  readonly shouldRest: boolean;
  static readonly pluginName: string = "DummyPlugin";
  readonly pluginName = DummyPlugin.pluginName;
  private static pluginConfig: DummyPluginConfig | undefined;
  pluginConfig: DummyPluginConfig;

  constructor(
    readonly engineConfig: CommonPluginEnv,
    pluginConfigRaw: Record<string, any>,
    readonly logger: Logger,
  ) {
    console.log(`Config: ${JSON.stringify(engineConfig, undefined, 2)}`);
    console.log(`Plugin Env: ${JSON.stringify(pluginConfigRaw, undefined, 2)}`);

    this.pluginConfig = DummyPlugin.validateConfig(pluginConfigRaw);
    this.shouldRest = this.pluginConfig.shouldRest;
    this.shouldSpy = this.pluginConfig.shouldSpy;
  }

  static validateConfig(
    pluginConfigRaw: Record<string, any>,
  ): DummyPluginConfig {
    return {
      spyServiceFilters:
        pluginConfigRaw.spyServiceFilters &&
        assertArray(pluginConfigRaw.spyServiceFilters, "spyServiceFilters"),
      shouldRest: assertBool(pluginConfigRaw.shouldRest, "shouldRest"),
      shouldSpy: assertBool(pluginConfigRaw.shouldSpy, "shouldSpy"),
    };
  }

  getFilters(): ContractFilter[] {
    return this.pluginConfig.spyServiceFilters;
  }

  async consumeEvent(
    vaa: ParsedVaaWithBytes,
    stagingArea: StagingAreaKeyLock,
  ): Promise<{ workflowData: WorkflowPayload }> {
    this.logger.debug("Parsing VAA...");
    this.logger.debug(`Parsed VAA: ${vaa.hash.toString("base64")}`);

    // example of reading and updating a key exclusively
    const count = await stagingArea.withKey(
      ["counter"],
      async ({ counter }) => {
        dbg(counter, "original")
        counter = (counter ? counter : 0) + 1;
        dbg(counter, "after plugin update")
        return {
          newKV: { counter },
          val: counter,
        };
      },
    );

    return {
      workflowData: {
        count,
        vaa: vaa.bytes.toString("base64"),
      },
    };
  }

  async handleWorkflow(
    workflow: Workflow,
    providers: Providers,
    execute: ActionExecutor,
  ): Promise<void> {
    this.logger.info("Got workflow");
    this.logger.debug(JSON.stringify(workflow, undefined, 2));

    const { vaa, count } = this.parseWorkflowPayload(workflow);

    const pubkey = await execute.onEVM({
      chainId: 6,
      f: async (wallet, chainId) => {
        const pubkey = wallet.wallet.address;
        this.logger.info(
          `Inside action, have wallet pubkey ${pubkey} on chain ${chainId}`,
        );
        this.logger.info(`Also have parsed vaa. seq: ${vaa.sequence}`);
        await sleep(500);
        return pubkey;
      },
    });

    this.logger.info(`Result of action on fuji ${pubkey}, Count: ${count}`);
  }

  parseWorkflowPayload(workflow: Workflow): WorkflwoPayloadDeserialized {
    const bytes = Buffer.from(workflow.data.vaa, "base64");
    const vaa = parseVaa(bytes) as ParsedVaaWithBytes;
    vaa.bytes = bytes;
    return {
      vaa,
      count: workflow.data.count as number,
    };
  }
}

class Definition implements PluginDefinition<DummyPluginConfig, DummyPlugin> {
  pluginName: string = DummyPlugin.pluginName;

  init(pluginConfig: any): {
    fn: EngineInitFn<DummyPlugin>;
    pluginName: string;
  } {
    const pluginConfigParsed: DummyPluginConfig =
      DummyPlugin.validateConfig(pluginConfig);
    return {
      fn: (env, logger) => new DummyPlugin(env, pluginConfigParsed, logger),
      pluginName: DummyPlugin.pluginName,
    };
  }
}

export default new Definition();
