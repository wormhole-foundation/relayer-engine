import * as ethers from "ethers";
import * as solana from "@solana/web3.js";
import {
  ChainId,
  EVMChainId,
  ParsedVaa,
  SignedVaa,
} from "@certusone/wormhole-sdk";
import * as winston from "winston";
import { WormholeInstruction } from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole/coder";

/*
 *  Config
 */

// subset of common env that plugins should have access to
export interface CommonPluginEnv {
  supportedChains: ChainConfigInfo[];
}

export enum EnvType {
  MAINNET = "MAINNET",
  DEVNET = "DEVNET",
  TILT = "TILT",
  LOCALHOST = "LOCALHOST",
  OTHER = "OTHER",
}

export interface ChainConfigInfo {
  chainId: ChainId;
  chainName: string;
  nodeUrl: string;
  tokenBridgeAddress?: string;
  bridgeAddress?: string;
  wrappedAsset?: string | null;
}

/*
 * Storage
 */

export interface Workflow<D = any> {
  id: WorkflowId;
  pluginName: string;
  data: D;
}

export interface ActionExecutor {
  <T, W extends Wallet>(action: Action<T, W>): Promise<T>;
  onSolana<T>(f: ActionFunc<T, SolanaWallet>): Promise<T>;
  onEVM<T>(action: Action<T, EVMWallet>): Promise<T>;
}

export type ActionFunc<T, W extends Wallet> = (
  walletToolBox: WalletToolBox<W>,
  chaidId: ChainId,
) => Promise<T>;

export interface Action<T, W extends Wallet> {
  chainId: ChainId;
  f: ActionFunc<T, W>;
}

export type WorkflowId = string;

export type StagingArea = Object; // Next action to be executed
/*
 * Wallets and Providers
 */

export type EVMWallet = ethers.Wallet;
export type Wallet = EVMWallet | SolanaWallet | CosmWallet;

export interface WalletToolBox<T extends Wallet> extends Providers {
  wallet: T;
}

export type SolanaWallet = {
  conn: solana.Connection;
  payer: solana.Keypair;
};

export type CosmWallet = {};

export interface Providers {
  evm: { [id in EVMChainId]: ethers.providers.Provider };
  solana: solana.Connection;
  // todo: rest of supported chain providers
}

export interface ParsedVaaWithBytes extends ParsedVaa {
  bytes: SignedVaa;
}

/*
 *  Plugin interfaces
 */

// Must be the default export for the plugin package
export interface PluginDefinition<
  PluginConfig,
  PluginType extends Plugin<WorkflowData>,
  WorkflowData = any,
> {
  init(pluginConfig: any | PluginConfig): {
    fn: EngineInitFn<PluginType>;
    pluginName: string;
  };
  pluginName: string;
}

// Function signature passed to the relayer-engine's `run` function
// The engine will provide the config and a scoped logger
export type EngineInitFn<PluginType extends Plugin> = (
  engineConfig: CommonPluginEnv,
  logger: winston.Logger,
  // when running with listener mode enabled, allow plugin to generate its own events
  // e.g. listening for logs from blockchain rpc, chron style recurring jobs etc.
  eventSource?: (event: SignedVaa) => Promise<void>,
) => PluginType;

export interface Plugin<WorkflowData = any> {
  pluginName: string; // String identifier for plug-in
  pluginConfig: any; // Configuration settings for plug-in
  shouldSpy: boolean; // Boolean toggle if relayer should connect to Guardian Network via non-validation guardiand node
  shouldRest: boolean; // Boolean toggle if relayer should connect to Guardian Network via REST API
  demoteInProgress?: boolean;
  getFilters(): ContractFilter[]; // List of emitter addresses and emiiter chain ID to filter for
  consumeEvent( // Function to be defined in plug-in that takes as input a VAA outputs a list of actions
    vaa: ParsedVaaWithBytes,
    stagingArea: StagingAreaKeyLock,
    providers: Providers,
  ): Promise<{ workflowData?: WorkflowData }>;
  handleWorkflow(
    workflow: Workflow<WorkflowData>,
    providers: Providers,
    execute: ActionExecutor,
  ): Promise<void>;
}

export type ContractFilter = {
  emitterAddress: string; // Emitter contract address to filter for
  chainId: ChainId; // Wormhole ChainID to filter for
};

export interface StagingAreaKeyLock {
  withKey<T>(
    keys: string[],
    f: (
      kv: Record<string, any>,
    ) => Promise<{ newKV: Record<string, any>; val: T }>,
  ): Promise<T>;
  getKeys(keys: string[]): Promise<Record<string, any>>;
}
