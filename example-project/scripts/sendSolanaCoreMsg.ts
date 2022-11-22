import * as wh from "@certusone/wormhole-sdk";
import * as web3 from "@solana/web3.js";
import { Socket } from "dgram";
import * as relayerEngine from "relayer-engine";
import { nnull } from "relayer-engine";
import {
  createMint,
  mintTo,
  getMint,
  getAccount,
  createAccount,
  syncNative,
  createAssociatedTokenAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

async function main() {
  const configs = await relayerEngine.loadRelayerEngineConfig(
    "./relayer-engine-config",
    relayerEngine.Mode.BOTH,
    {}
  );
  console.log("NOTE: only works for testnet/devnet");

  const solanaConfig = nnull(
    configs.commonEnv.supportedChains.find(
      (c) => c.chainId === wh.CHAIN_ID_SOLANA
    )
  );
  const fujiConfig = nnull(
    configs.commonEnv.supportedChains.find(
      (c) => c.chainId === wh.CHAIN_ID_AVAX
    )
  );

  const keypairRaw = JSON.parse(nnull(configs.executorEnv?.privateKeys[1][0]));
  const payer = web3.Keypair.fromSecretKey(Buffer.from(keypairRaw));

  const conn = new web3.Connection(solanaConfig.nodeUrl, {
    commitment: <web3.Commitment>"confirmed",
  });

  conn
    .requestAirdrop(payer.publicKey, 2_000_000_000)
    .then((e) => console.error(e));

  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    new web3.PublicKey(wh.WSOL_ADDRESS),
    payer.publicKey
  );
  createAssociatedTokenAccount();
  syncNative();

  const tx = await wh.transferNativeSol(
    conn,
    nnull(solanaConfig.bridgeAddress),
    nnull(solanaConfig.tokenBridgeAddress),
    payer.publicKey,
    BigInt(100_000_000),
    wh.tryNativeToUint8Array(nnull(fujiConfig.bridgeAddress), 6),
    fujiConfig.chainId
  );
  tx.partialSign(payer);

  console.log(tx.instructions.map((ix) => ix.keys));

  const txSiq = await web3.sendAndConfirmRawTransaction(conn, tx.serialize(), {
    skipPreflight: true,
  });

  const rx = nnull(await conn.getTransaction(txSiq));
  const seq = wh.parseSequenceFromLogSolana(rx);
  console.log(seq);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
