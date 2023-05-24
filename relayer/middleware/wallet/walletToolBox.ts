import * as wh from "@certusone/wormhole-sdk";
import * as bs58 from "bs58";
import { ethers } from "ethers";
import * as solana from "@solana/web3.js";
import { Providers } from "../providers.middleware";
import {
  EVMWallet,
  SeiWallet,
  SolanaWallet,
  SuiWallet,
  Wallet,
} from "./wallet.middleware";
import { Ed25519Keypair, RawSigner } from "@mysten/sui.js";
import { DirectSecp256k1Wallet } from "@cosmjs/proto-signing";

export interface WalletToolBox<T extends Wallet> extends Providers {
  wallet: T;
  getBalance(): Promise<string>;
  address: string;
}

export async function createWalletToolbox(
  providers: Providers,
  privateKey: string,
  chainId: wh.ChainId,
): Promise<WalletToolBox<any>> {
  if (wh.isEVMChain(chainId)) {
    return createEVMWalletToolBox(providers, privateKey, chainId);
  }
  switch (chainId) {
    case wh.CHAIN_ID_SOLANA:
      let secretKey;
      try {
        secretKey = bs58.decode(privateKey);
      } catch (e) {
        secretKey = new Uint8Array(JSON.parse(privateKey));
      }
      return createSolanaWalletToolBox(providers, secretKey);
    case wh.CHAIN_ID_SUI:
      const secret = Buffer.from(privateKey, "base64");
      return createSuiWalletToolBox(providers, secret);
    case wh.CHAIN_ID_SEI:
      const seiPkBuf = Buffer.from(privateKey, "hex");
      return createSeiWalletToolBox(providers, seiPkBuf);
  }
}

function createEVMWalletToolBox(
  providers: Providers,
  privateKey: string,
  chainId: wh.EVMChainId,
): WalletToolBox<EVMWallet> {
  const wallet = new ethers.Wallet(privateKey, providers.evm[chainId][0]);
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
  return {
    ...providers,
    wallet: {
      conn: providers.solana[0],
      payer: solana.Keypair.fromSecretKey(privateKey),
    },
    async getBalance(): Promise<string> {
      return "TODO";
    },
    address: "TODO",
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
