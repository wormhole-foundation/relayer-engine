import {
  ActionExecutor,
  assertArray,
  CommonPluginEnv,
  ContractFilter,
  Plugin,
  PluginFactory,
  Providers,
  StagingArea,
  Workflow,
} from "relayer-engine";
import * as wh from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import { assertBool } from "./utils";

export interface DummyPluginConfig {
  spyServiceFilters?: { chainId: wh.ChainId; emitterAddress: string }[];
  shouldRest: boolean;
  shouldSpy: boolean;
  demoteInProgress: boolean;
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
  readonly pluginConfig: DummyPluginConfig;
  readonly demoteInProgress;

  constructor(
    readonly config: CommonPluginEnv,
    env: Record<string, any>,
    readonly logger: Logger
  ) {
    console.log(`Config: ${JSON.stringify(config, undefined, 2)}`);
    console.log(`Plugin Env: ${JSON.stringify(env, undefined, 2)}`);

    this.pluginConfig = {
      spyServiceFilters:
        env.spyServiceFilters &&
        assertArray(env.spyServiceFilters, "spyServiceFilters"),
      shouldRest: assertBool(env.shouldRest, "shouldRest"),
      shouldSpy: assertBool(env.shouldSpy, "shouldSpy"),
      demoteInProgress:
        env.demoteInProgress &&
        assertBool(env.demoteInProgress, "demoteInProgress"),
    };
    this.shouldRest = this.pluginConfig.shouldRest;
    this.shouldSpy = this.pluginConfig.shouldSpy;
    this.demoteInProgress = this.pluginConfig.demoteInProgress;
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

    const pubkey = await execute.onSolana(async (wallet, chainId) => {
      const pubkey = wallet.wallet.payer.publicKey.toBase58();
      this.logger.info(
        `We got dat wallet pubkey ${pubkey} on chain ${chainId}`
      );
      this.logger.info(`Also have parsed vaa. seq: ${parsed.sequence}`);
      return pubkey;
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

export default class DummyPluginFactory implements PluginFactory {
  pluginName: string = DummyPlugin.pluginName;
  constructor(readonly pluginConfig: DummyPluginConfig) {}

  init(config: CommonPluginEnv, logger: Logger): DummyPlugin {
    return new DummyPlugin(config, this.pluginConfig, logger);
  }
}
