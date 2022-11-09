import {
  ActionExecutor,
  assertArray,
  CommonEnv,
  CommonPluginEnv,
  ContractFilter,
  Plugin,
  PluginDefinition,
  Providers,
  StagingArea,
  Workflow,
} from "relayer-engine";
import * as wh from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import { assertBool } from "./utils";
import { ChainId } from "@certusone/wormhole-sdk";

export interface DummyPluginConfig {
  spyServiceFilters?: { chainId: wh.ChainId; emitterAddress: string }[];
  shouldRest: boolean;
  shouldSpy: boolean;
}

interface WorkflowPayload {
  vaa: string; // base64
  time: number;
}

export class DummyPlugin implements Plugin<WorkflowPayload> {
  readonly shouldSpy: boolean;
  readonly shouldRest: boolean;
  static readonly pluginName: string = "DummyPlugin";
  readonly pluginName = DummyPlugin.pluginName;
  private static pluginConfig: DummyPluginConfig | undefined;
  pluginConfig: DummyPluginConfig;

  static init(
    pluginConfig: any
  ): (env: CommonEnv, logger: Logger) => DummyPlugin {
    const pluginConfigParsed: DummyPluginConfig = {
      spyServiceFilters:
        pluginConfig.spyServiceFilters &&
        assertArray(pluginConfig.spyServiceFilters, "spyServiceFilters"),
      shouldRest: assertBool(pluginConfig.shouldRest, "shouldRest"),
      shouldSpy: assertBool(pluginConfig.shouldSpy, "shouldSpy"),
    };
    return (env, logger) => new DummyPlugin(env, pluginConfigParsed, logger);
  }

  constructor(
    readonly engineConfig: CommonPluginEnv,
    pluginConfigRaw: Record<string, any>,
    readonly logger: Logger
  ) {
    console.log(`Config: ${JSON.stringify(engineConfig, undefined, 2)}`);
    console.log(`Plugin Env: ${JSON.stringify(pluginConfigRaw, undefined, 2)}`);

    this.pluginConfig = {
      spyServiceFilters:
        pluginConfigRaw.spyServiceFilters &&
        assertArray(pluginConfigRaw.spyServiceFilters, "spyServiceFilters"),
      shouldRest: assertBool(pluginConfigRaw.shouldRest, "shouldRest"),
      shouldSpy: assertBool(pluginConfigRaw.shouldSpy, "shouldSpy"),
    };
    this.shouldRest = this.pluginConfig.shouldRest;
    this.shouldSpy = this.pluginConfig.shouldSpy;
  }

  getFilters(): ContractFilter[] {
    if (this.pluginConfig.spyServiceFilters) {
      return this.pluginConfig.spyServiceFilters;
    }
    this.logger.error("Contract filters not specified in config");
    throw new Error("Contract filters not specified in config");
  }

  async consumeEvent(
    vaa: Buffer,
    stagingArea: { counter?: number }
  ): Promise<{ workflowData: WorkflowPayload; nextStagingArea: StagingArea }> {
    this.logger.debug("Parsing VAA...");
    const parsed = wh.parseVaa(vaa);
    this.logger.debug(`Parsed VAA: ${parsed && parsed.hash}`);
    return {
      workflowData: {
        time: new Date().getTime(),
        vaa: vaa.toString("base64"),
      },
      nextStagingArea: {
        counter: stagingArea?.counter ? stagingArea.counter + 1 : 0,
      },
    };
  }

  async handleWorkflow(
    workflow: Workflow,
    providers: Providers,
    execute: ActionExecutor
  ): Promise<void> {
    this.logger.info("Got workflow");
    this.logger.debug(JSON.stringify(workflow, undefined, 2));

    const payload = this.parseWorkflowPayload(workflow);
    const parsed = wh.parseVaa(payload.vaa);

    const pubkey = await execute.onEVM({
      chainId: 2 as ChainId,
      f: async (wallet, chainId) => {
        const pubkey = wallet.wallet.address;
        this.logger.info(
          `We got dat wallet pubkey ${pubkey} on chain ${chainId}`
        );
        this.logger.info(`Also have parsed vaa. seq: ${parsed.sequence}`);
        return pubkey;
      },
    });

    this.logger.info(`Result of action on solana ${pubkey}`);
  }

  parseWorkflowPayload(workflow: Workflow): { vaa: Buffer; time: number } {
    return {
      vaa: Buffer.from(workflow.data.vaa, "base64"),
      time: workflow.data.time as number,
    };
  }
}

class Definition implements PluginDefinition<DummyPluginConfig, DummyPlugin> {
  pluginName: string = DummyPlugin.pluginName;

  defaultConfig(env: CommonPluginEnv): DummyPluginConfig {
    return {
      shouldRest: false,
      shouldSpy: true,
      spyServiceFilters: [],
    };
  }

  init(pluginConfig?: any): (engineConfig: CommonPluginEnv, logger: Logger) => DummyPlugin {
    if (!pluginConfig) {
      return (env, logger) => {
        const defaultPluginConfig = this.defaultConfig(env);
        return new DummyPlugin(env, pluginConfigParsed, logger);
      };
    }
    const pluginConfigParsed: DummyPluginConfig = {
      spyServiceFilters:
        pluginConfig.spyServiceFilters &&
        assertArray(pluginConfig.spyServiceFilters, "spyServiceFilters"),
      shouldRest: assertBool(pluginConfig.shouldRest, "shouldRest"),
      shouldSpy: assertBool(pluginConfig.shouldSpy, "shouldSpy"),
    };
    return (env, logger) => new DummyPlugin(env, pluginConfigParsed, logger);
  }
}

export default new Definition();
