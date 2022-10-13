import {
  ActionExecutor,
  CommonPluginEnv,
  ContractFilter,
  CosmWallet,
  EVMWallet,
  Plugin,
  PluginFactory,
  Providers,
  SolanaWallet,
  StagingArea,
  Workflow,
} from "plugin_interface";
import * as wh from "@certusone/wormhole-sdk";
import { Logger, loggers } from "winston";

// todo: do we need this in the plugin or just the relayer??
wh.setDefaultWasm("node");

function create(
  commonConfig: CommonPluginEnv,
  pluginConfig: any,
  logger: Logger
): Plugin {
  console.log("Creating da plugin...");
  return new DummyPlugin(commonConfig, pluginConfig, logger);
}

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
  readonly dependentPluginNames: string[] = ["AttestationPlugin"];

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
    const parsed = await this.parseVAA(vaa);
    this.logger.debug(`Parsed VAA: ${JSON.stringify(parsed)}`);
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
    const parsed = await this.parseVAA(payload.vaa);

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

  async parseVAA(vaa: number[] | Uint8Array): Promise<BaseVAA> {
    try {
      const { parse_vaa } = await wh.importCoreWasm();
      return parse_vaa(new Uint8Array(vaa)) as BaseVAA;
    } catch (e) {
      this.logger.error("Failed to parse vaa");
      throw e;
    }
  }
}

const factory: PluginFactory = { create, pluginName: DummyPlugin.pluginName };
console.log(factory.pluginName);

export default factory;

function assertInt(x: any, fieldName?: string): number {
  if (!Number.isInteger(x)) {
    const e = new Error(`Expected field to be integer, found ${x}`) as any;
    e.fieldName = fieldName;
    throw e;
  }
  return x as number;
}

function assertArray<T>(x: any, fieldName?: string): T[] {
  if (!Array.isArray(x)) {
    const e = new Error(`Expected field to be array, found ${x}`) as any;
    e.fieldName = fieldName;
    throw e;
  }
  return x as T[];
}

function assertBool(x: any, fieldName?: string): boolean {
  if (x !== false && x !== true) {
    const e = new Error(`Expected field to be boolean, found ${x}`) as any;
    e.fieldName = fieldName;
    throw e;
  }
  return x as boolean;
}

function nnull<T>(x: T | undefined | null, errMsg?: string): T {
  if (x === undefined || x === null) {
    throw new Error("Found unexpected undefined or null. " + errMsg);
  }
  return x;
}

export interface BaseVAA {
  version: number;
  guardianSetIndex: number;
  timestamp: number;
  nonce: number;
  emitter_chain: wh.ChainId;
  emitter_address: Uint8Array; // 32 bytes
  sequence: number;
  consistency_level: number;
  payload: Uint8Array;
}
