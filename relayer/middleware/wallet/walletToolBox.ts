import * as wh from "@certusone/wormhole-sdk";
import * as bs58 from "bs58";
import { ethers } from "ethers";
import * as solana from "@solana/web3.js";
import { Providers } from "../providers.middleware";
import { EVMWallet, SolanaWallet, Wallet } from "./wallet.middleware";

export interface WalletToolBox<T extends Wallet> extends Providers {
  wallet: T;
}

export function createWalletToolbox(
  providers: Providers,
  privateKey: string,
  chainId: wh.ChainId,
): WalletToolBox<any> {
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
  }
}

function createEVMWalletToolBox(
  providers: Providers,
  privateKey: string,
  chainId: wh.EVMChainId,
): WalletToolBox<EVMWallet> {
  return {
    ...providers,
    wallet: new ethers.Wallet(privateKey, providers.evm[chainId][0]),
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
  };
}
