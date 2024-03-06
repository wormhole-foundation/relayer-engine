import { ethers } from "ethers";
import * as solana from "@solana/web3.js";
import { Providers } from "../providers.middleware.js";
import {
  EVMWallet,
  SeiWallet,
  SolanaWallet,
  SuiWallet,
  Wallet,
} from "./wallet.middleware.js";
import { Ed25519Keypair, RawSigner } from "@mysten/sui.js";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import {
  chainToPlatform,
  toChainId,
  toChain,
  ChainId,
  Chain,
} from "@wormhole-foundation/sdk";
import { EvmChains } from "@wormhole-foundation/sdk-evm";

export interface WalletToolBox<T extends Wallet> extends Providers {
  wallet: T;
  address: string;

  getBalance(): Promise<string>;
}

export async function createWalletToolbox(
  providers: Providers,
  privateKey: string,
  chainId: ChainId,
): Promise<WalletToolBox<any>> {
  const chain: Chain = toChain(chainId);
  if (chainToPlatform(toChain(chainId)) === "Evm") {
    return createEVMWalletToolBox(providers, privateKey, chainId);
  }
  switch (chain) {
    case "Solana":
      let secretKey;
      try {
        secretKey = ethers.utils.base58.decode(privateKey);
      } catch (e) {
        secretKey = new Uint8Array(JSON.parse(privateKey));
      }
      return createSolanaWalletToolBox(providers, secretKey);
    case "Sui":
      const secret = Buffer.from(privateKey, "base64");
      return createSuiWalletToolBox(providers, secret);
    case "Sei":
      const seiPkBuf = Buffer.from(privateKey, "hex");
      return createSeiWalletToolBox(providers, seiPkBuf);
  }

  throw new Error(`Unknown chain id ${chainId}`);
}

function createEVMWalletToolBox(
  providers: Providers,
  privateKey: string,
  chainId: ChainId,
): WalletToolBox<EVMWallet> {
  const chain = toChain(chainId);
  const chainProviders = providers.evm[chain as EvmChains];
  if (chainProviders === undefined || chainProviders.length === 0) {
    throw new Error(`No provider found for chain ${chainId}`);
  }
  const wallet = new ethers.Wallet(privateKey, chainProviders[0]);
  return {
    ...providers,
    wallet: wallet,
    async getBalance(): Promise<string> {
      const b = await wallet.getBalance();
      return b.toString();
    },
    address: wallet.address,
  };
}

function createSolanaWalletToolBox(
  providers: Providers,
  privateKey: Uint8Array,
): WalletToolBox<SolanaWallet> {
  const keypair = solana.Keypair.fromSecretKey(privateKey);
  return {
    ...providers,
    wallet: {
      conn: providers.solana[0],
      payer: keypair,
    },
    async getBalance(): Promise<string> {
      return (
        await providers.solana[0].getBalance(keypair.publicKey)
      ).toString();
    },
    address: keypair.publicKey.toBase58(),
  };
}

function createSuiWalletToolBox(
  providers: Providers,
  secret: Buffer,
): WalletToolBox<SuiWallet> {
  const keyPair = Ed25519Keypair.fromSecretKey(secret);
  const suiProvider = providers.sui[0];
  const wallet = new RawSigner(keyPair, suiProvider);
  const address = keyPair.getPublicKey().toSuiAddress();
  return {
    ...providers,
    wallet,
    async getBalance(): Promise<string> {
      const b = await suiProvider.getBalance({
        owner: address,
      });
      return b.totalBalance.toString();
    },
    address: address,
  };
}

async function createSeiWalletToolBox(
  providers: Providers,
  privateKey: Buffer,
): Promise<WalletToolBox<SeiWallet>> {
  const seiWallet = await DirectSecp256k1Wallet.fromKey(privateKey, "sei");
  const [seiAccount] = await seiWallet.getAccounts();

  const seiProvider = providers.sei[0];

  return {
    ...providers,
    wallet: seiWallet,
    address: seiAccount.address,
    async getBalance(): Promise<string> {
      const b = await seiProvider.getBalance(seiAccount.address, "usei");
      return b.amount;
    },
  };
}
