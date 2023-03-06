import {
  ActionExecutor,
  assertArray,
  CommonPluginEnv,
  ContractFilter,
  ParsedVaaWithBytes,
  Plugin,
  Providers,
  sleep,
  StagingAreaKeyLock,
  Workflow,
  WorkflowOptions,
} from "relayer-engine";
import * as wh from "@certusone/wormhole-sdk";
import { Logger } from "winston";
import { parseVaa } from "@certusone/wormhole-sdk";

export interface DummyPluginConfig {
  spyServiceFilters: { chainId: wh.ChainId; emitterAddress: string }[];
}

// Serialized version of WorkloadPayload
// This is what is returned by the consumeEvent and received by handleWorkflow
interface WorkflowPayload {
  vaa: string; // base64
  count: number;
}

// Deserialized version of WorkloadPayload
interface WorkflwoPayloadDeserialized {
  vaa: ParsedVaaWithBytes;
  count: number;
}

const randomInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1) + min);

export class DummyPlugin implements Plugin<WorkflowPayload> {
  // configuration fields used by engine
  readonly shouldSpy: boolean = true;
  readonly shouldRest: boolean = false;
  readonly maxRetries = 10;
  static readonly pluginName: string = "DummyPlugin";
  readonly pluginName = DummyPlugin.pluginName;

  // config used by plugin
  pluginConfig: DummyPluginConfig;

  constructor(
    readonly engineConfig: CommonPluginEnv,
    pluginConfigRaw: Record<string, any>,
    readonly logger: Logger,
  ) {
    console.log(`Config: ${JSON.stringify(engineConfig, undefined, 2)}`);
    console.log(`Plugin Env: ${JSON.stringify(pluginConfigRaw, undefined, 2)}`);

    this.pluginConfig = DummyPlugin.validateConfig(pluginConfigRaw);
  }

  // Validate the plugin's config
  static validateConfig(
    pluginConfigRaw: Record<string, any>,
  ): DummyPluginConfig {
    return {
      spyServiceFilters:
        pluginConfigRaw.spyServiceFilters &&
        assertArray(pluginConfigRaw.spyServiceFilters, "spyServiceFilters"),
    };
  }

  getFilters(): ContractFilter[] {
    return this.pluginConfig.spyServiceFilters;
  }

  async consumeEvent(
    vaa: ParsedVaaWithBytes,
    stagingArea: StagingAreaKeyLock,
  ): Promise<
    | {
        workflowData: WorkflowPayload;
        workflowOptions?: WorkflowOptions;
      }
    | undefined
  > {
    this.logger.debug(`VAA hash: ${vaa.hash.toString("base64")}`);

    // Example of reading and updating a key exclusively
    // This allows multiple listeners to run in separate processes safely
    const count = await stagingArea.withKey(
      ["counter"],
      async ({ counter }) => {
        this.logger.debug(`Original counter value ${counter}`);
        counter = (counter ? counter : 0) + 1;
        this.logger.debug(`Counter value after update ${counter}`);
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
    this.logger.info("Got workflow", { workflowId: workflow.id });
    this.logger.debug(JSON.stringify(workflow, undefined, 2));

    const { vaa, count } = this.parseWorkflowPayload(workflow);

    // Dummy job illustrating how to run an action on the wallet worker pool
    const pubkey = await execute.onEVM({
      chainId: 6, // EVM chain to get a wallet for
      f: async (wallet, chainId) => {
        const pubkey = wallet.wallet.address;
        this.logger.info(
          `Inside action, have wallet pubkey ${pubkey} on chain ${chainId}`,
          { pubKey: pubkey, chainId: chainId },
        );
        this.logger.info(`Also have parsed vaa. seq: ${vaa.sequence}`, {
          vaa: vaa,
        });
        return pubkey;
      },
    });

    // Simulate different processing times for metrics
    await sleep(randomInt(0, 4000));

    let PROBABILITY_OF_FAILURE = 0.01;
    if (Math.random() < PROBABILITY_OF_FAILURE) {
      throw new Error("Simulating workflow failure");
    }

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
