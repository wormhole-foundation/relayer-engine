import * as ethers from "ethers";
import * as solana from "@solana/web3.js";
import * as sui from "@mysten/sui.js";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import * as winston from "winston";
import { ChainId, VAA } from "@wormhole-foundation/sdk";
import { EvmChains } from "@wormhole-foundation/sdk-evm";

/*
 *  Config
 */

// subset of common env that plugins should have access to
export interface CommonPluginEnv {
  supportedChains: ChainConfigInfo[];
  wormholeRpc: string;
}

export interface ChainConfigInfo {
  chainId: ChainId;
  chainName: string;
  nodeUrl: string;
}

/*
 * Storage
 */

export interface Workflow<D = any> {
  id: WorkflowId;
  pluginName: string;
  scheduledAt?: Date;
  scheduledBy?: string;
  retryCount: number;
  maxRetries?: number;
  data: D;
  failedAt?: Date;
  errorMessage?: string;
  errorStacktrace?: string;
  completedAt?: Date;
  startedProcessingAt?: Date;
  processingBy?: string;
  emitterChain?: number;
  emitterAddress?: string;
  sequence?: string;
}

export interface ActionExecutor {
  <T, W extends Wallet>(action: Action<T, W>): Promise<T>;
  onSolana<T>(f: ActionFunc<T, SolanaWallet>): Promise<T>;
  onEVM<T>(action: Action<T, EVMWallet>): Promise<T>;
  onSui<T>(action: Action<T, EVMWallet>): Promise<T>;
}

export type ActionFunc<T, W extends Wallet> = (
  walletToolBox: WalletToolBox<W>,
  chaindId: ChainId,
) => Promise<T>;

export interface Action<T, W extends Wallet> {
  chainId: ChainId;
  f: ActionFunc<T, W>;
}

export type WorkflowId = string;

/*
 * Wallets and Providers
 */

export type UntypedProvider = {
  rpcUrl: string;
};
export type EVMWallet = ethers.Wallet;
export type UntypedWallet = UntypedProvider & {
  privateKey: string;
};
export type SolanaWallet = {
  conn: solana.Connection;
  payer: solana.Keypair;
};

export type Wallet = EVMWallet | SolanaWallet | UntypedWallet;

export interface WalletToolBox<T extends Wallet> extends Providers {
  wallet: T;
}

export interface Providers {
  untyped: Partial<Record<ChainId, UntypedProvider>>;
  evm: Partial<Record<EvmChains, ethers.providers.Provider>>;
  solana: solana.Connection;
  sui: sui.JsonRpcProvider;
  sei: CosmWasmClient;
}

/*
 *  Plugin interfaces
 */

// Function signature passed to the relayer-engine's `run` function
// The engine will provide the config and a scoped logger
export type EngineInitFn<PluginType extends Plugin> = (
  engineConfig: CommonPluginEnv,
  logger: winston.Logger,
) => PluginType;

export interface WorkflowOptions {
  maxRetries?: number;
}

export interface Plugin<WorkflowData = any> {
  pluginName: string; // String identifier for plugin
  pluginConfig: any; // Configuration settings for plugin
  shouldSpy: boolean; // Boolean toggle if relayer should connect to Guardian Network via non-validation guardiand node
  shouldRest: boolean; // Boolean toggle if relayer should connect to Guardian Network via REST API
  maxRetries?: number;

  afterSetup?(
    providers: Providers,
    listenerResources?: { eventSource: EventSource; db: StagingAreaKeyLock },
  ): Promise<void>;

  getFilters(): ContractFilter[]; // List of emitter addresses and emiiter chain ID to filter for
  consumeEvent( // Function to be defined in plug-in that takes as input a VAA outputs a list of actions
    vaa: VAA,
    stagingArea: StagingAreaKeyLock,
    providers: Providers,
    extraData?: any[],
  ): Promise<
    | {
        workflowData: WorkflowData;
        workflowOptions?: WorkflowOptions;
      }
    | undefined
  >;

  handleWorkflow(
    workflow: Workflow<WorkflowData>,
    providers: Providers,
    execute: ActionExecutor,
  ): Promise<void>;
}

export type EventSource = (
  event: Uint8Array,
  extraData?: any[],
) => Promise<void>;

export type ContractFilter = {
  emitterAddress: string; // Emitter contract address to filter for
  chainId: ChainId; // Wormhole ChainID to filter for
  doNotTransform?: boolean; // If true, do not do chain specific transformation into wormhole emitter address format
};

export interface StagingAreaKeyLock {
  withKey<T, KV extends Record<string, any>>(
    keys: string[],
    f: (kvs: KV, ctx: OpaqueTx) => Promise<{ newKV: KV; val: T }>,
    tx?: OpaqueTx,
  ): Promise<T>;

  getKeys<KV extends Record<string, any>>(keys: string[]): Promise<KV>;
}

export type OpaqueTx = never;
