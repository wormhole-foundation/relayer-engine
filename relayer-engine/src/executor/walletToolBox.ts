import * as wh from "@certusone/wormhole-sdk";
import { ethers } from "ethers";
import {
  EVMWallet,
  Providers,
  SolanaWallet,
  WalletToolBox,
} from "../../packages/relayer-plugin-interface";
import * as solana from "@solana/web3.js";
import { dbg } from "../helpers/logHelper";

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
      return createSolanaWalletToolBox(
        providers,
        new Uint8Array(JSON.parse(privateKey)),
      );
    default:
      return {
        ...providers,
        wallet: { ...providers.untyped[chainId], privateKey },
      };
  }
}

function createEVMWalletToolBox(
  providers: Providers,
  privateKey: string,
  chainId: wh.EVMChainId,
): WalletToolBox<EVMWallet> {
  return {
    ...providers,
    wallet: new ethers.Wallet(privateKey, providers.evm[chainId]),
  };
}

function createSolanaWalletToolBox(
  providers: Providers,
  privateKey: Uint8Array,
): WalletToolBox<SolanaWallet> {
  return {
    ...providers,
    wallet: {
      conn: providers.solana,
      payer: solana.Keypair.fromSecretKey(privateKey),
    },
  };
}
