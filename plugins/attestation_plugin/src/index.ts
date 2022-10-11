import {
  ActionExecutor,
  ActionId,
  ActionQueueUpdate,
  CommonPluginEnv,
  ContractFilter,
  EVMWallet,
  Plugin,
  PluginFactory,
  Providers,
  StagingArea,
  WorkerAction,
  Workflow,
} from "plugin_interface";
import * as wh from "@certusone/wormhole-sdk";
import { Logger, loggers } from "winston";
import { WalletToolBox } from "plugin_interface";
import { BigNumber } from "ethers";
import { sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

function create(
  commonConfig: CommonPluginEnv,
  pluginConfig: any,
  logger: Logger
): Plugin {
  return new AttestationPlugin(commonConfig, pluginConfig, logger);
}

interface AttestationPluginConfig {
  spyServiceFilters?: { chainId: wh.ChainId; emitterAddress: string }[];
  shouldRest: boolean;
  shouldSpy: boolean;
  demoteInProgress: boolean;

  // Chains to createWrapped on when finding a attestation VAA
  createWrappedOnChains: wh.ChainId[];
}

interface AttestationWorkflowData {
  attest: AttestPayload;
  base: BaseVAA;
  bytes: Uint8Array;
}

// async function attestationWorkflow(
//   execute: (action: WorkerAction) => Promise<any>
//   // ..
// ): Promise<void> {
//   const craeatAttestation = {}; // ...
//   const { seq, emitter } = await execute(craeatAttestation);
//   const vaa = await execute(fetch(seq, emitter));

//   await Promise.all(
//     allTheChains.map(c => execute(createWrappedAssetAction(vaa, c)))
//   );
// }

class AttestationPlugin implements Plugin {
  readonly shouldSpy: boolean;
  readonly shouldRest: boolean;
  static readonly pluginName: string = "AttestationPlugin";
  readonly pluginName = AttestationPlugin.pluginName;
  readonly pluginConfig: AttestationPluginConfig;
  readonly demoteInProgress: boolean;

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
      createWrappedOnChains:
        env.createWrappedOnChains &&
        assertArray(env.createWrappedOnChains, "createWrappedChainsOn"),
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
    vaa: Uint8Array,
    stagingArea: StagingArea
  ): Promise<{
    workflowData?: AttestationWorkflowData;
    nextStagingArea: StagingArea;
  }> {
    const base = await this.parseVAA(vaa);
    const attest = parseAttestPayload(Buffer.from(base.payload));
    if (!attest || this.pluginConfig.createWrappedOnChains.length === 0) {
      // not a attestation portal message
      return { nextStagingArea: stagingArea };
    }
    return {
      workflowData: { attest, base, bytes: vaa },
      nextStagingArea: stagingArea,
    };
  }

  async handleWorkflow(
    workflow: Workflow<AttestationWorkflowData>,
    providers: Providers,
    execute: ActionExecutor
  ): Promise<void> {
    if (this.pluginConfig.createWrappedOnChains.length === 0) {
      this.logger.warn(
        "Found attestation workflow, but no chains listed in 'createWrappedOnChains'"
      );
      return;
    }
    await Promise.all(
      this.pluginConfig.createWrappedOnChains.map(c =>
        this.createWrapped(workflow.data, c, providers, execute)
      )
    );
    this.logger.info(
      `Done attesting token '${workflow.data.attest.name}' on configured chains`
    );
  }

  async createWrapped(
    { attest, bytes }: AttestationWorkflowData,
    chain: wh.ChainId,
    providers: Providers,
    execute: ActionExecutor
  ): Promise<void> {
    const chainConfig = this.config.supportedChains.find(
      c => c.chainId === chain
    );
    if (!chainConfig) {
      throw new Error("unsupportedChainSpecified: " + chain);
    }
    if (chain === wh.CHAIN_ID_SOLANA) {
      await execute.onSolana(async wallet => {
        this.logger.info("Posting VAA on Solana...");
        await wh.postVaaSolanaWithRetry(
          wallet.wallet.conn,
          async transaction => {
            transaction.partialSign(wallet.wallet.payer);
            return transaction;
          },
          nnull(chainConfig.bridgeAddress),
          wallet.wallet.payer.publicKey.toString(),
          Buffer.from(bytes),
          10
        );

        this.logger.info("Creating wrapped asset on Solana...");
        const tx = await wh.createWrappedOnSolana(
          wallet.wallet.conn,
          nnull(chainConfig.bridgeAddress),
          chainConfig.tokenBridgeAddress,
          wallet.wallet.payer.publicKey.toBase58(),
          bytes
        );
        await sendAndConfirmTransaction(
          wallet.wallet.conn,
          tx,
          [wallet.wallet.payer],
          { commitment: "confirmed" }
        );
        this.logger.info("Wrapped asset created on Solana");
      });
      await new Promise(r => setTimeout(r, 5000));
      const foreignAddress = await wh.getForeignAssetSolana(
        providers.solana,
        chainConfig.tokenBridgeAddress,
        attest.tokenChain,
        attest.tokenAddress
      );
      console.log(
        `${attest.tokenChain} Network has new PortalWrappedToken for ${chain} network at ${foreignAddress}`
      );
    } else if (wh.isEVMChain(chain)) {
      await execute.onEVM({
        chainId: chain,
        f: async ({ wallet }) => {
          const tx = await wh.createWrappedOnEth(
            chainConfig.tokenBridgeAddress,
            wallet,
            Buffer.from(bytes),
            {
              gasLimit: 10000000,
            }
          );
        },
      });
      await new Promise(r => setTimeout(r, 5000));
      const foreignAddress = await wh.getForeignAssetEth(
        chainConfig.tokenBridgeAddress,
        providers.evm[chain],
        chain,
        attest.tokenAddress
      );
      console.log(
        `${attest.tokenChain} Network has new PortalWrappedToken for ${chain} network at ${foreignAddress}`
      );
    } else {
      this.logger.error(
        `Unsupported chain ${chain}. Only EVM and Solana supported`
      );
    }
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

const factory: PluginFactory = {
  create,
  pluginName: AttestationPlugin.pluginName,
};

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

interface AttestPayload {
  tokenAddress: Buffer;
  tokenChain: wh.ChainId;
  decimals: number;
  symbol: string;
  name: string;
}

function parseTransferPayload(arr: Buffer) {
  return {
    amount: BigNumber.from(arr.subarray(1, 1 + 32)).toBigInt(),
    originAddress: arr.subarray(33, 33 + 32).toString("hex"),
    originChain: arr.readUInt16BE(65) as wh.ChainId,
    targetAddress: arr.subarray(67, 67 + 32).toString("hex"),
    targetChain: arr.readUInt16BE(99) as wh.ChainId,
    fee: BigNumber.from(arr.subarray(101, 101 + 32)).toBigInt(),
  };
}

function parseAttestPayload(arr: Buffer): AttestPayload | null {
  if (arr.readUint8(0) !== 2) {
    return null;
  }
  return {
    tokenAddress: arr.subarray(1, 1 + 32),
    tokenChain: arr.readUInt16BE(33) as wh.ChainId,
    decimals: arr.readUint8(35),
    symbol: arr.subarray(36, 36 + 32).toString("utf-8"),
    name: arr.subarray(69, 69 + 32).toString("utf-8"),
  };
}
