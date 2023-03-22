import * as wh from "@certusone/wormhole-sdk";
import * as web3 from "@solana/web3.js";
import * as relayerEngine from "relayer-engine";
import { nnull, sleep } from "relayer-engine";

// Test script to send VAAs from devnet Solana to Fuji Avax
// By default it sends 1 VAA
// Calling with `ts-node sendSolanaNative.ts {num} sends {num} VAAs
// Calling with `ts-node sendSolanaNative.ts loop sends VAAs in a loop every 10 sec
async function main() {
  console.log(process.argv);
  const configs = await relayerEngine.loadRelayerEngineConfig(
    "./relayer-engine-config",
    relayerEngine.Mode.BOTH,
  );

  console.log("");
  console.log("NOTE: only works for testnet/devnet");
  console.log("");

  const solanaConfig = nnull(
    configs.commonEnv.supportedChains.find(
      c => c.chainId === wh.CHAIN_ID_SOLANA,
    ),
  );
  const fujiConfig = nnull(
    configs.commonEnv.supportedChains.find(c => c.chainId === wh.CHAIN_ID_AVAX),
  );

  const keypairRaw = JSON.parse(nnull(configs.executorEnv?.privateKeys[1][0]));
  const payer = web3.Keypair.fromSecretKey(Buffer.from(keypairRaw));

  const conn = new web3.Connection(solanaConfig.nodeUrl, {
    commitment: <web3.Commitment>"confirmed",
  });

  console.log("Payer: " + payer.publicKey.toBase58());

  conn
    .requestAirdrop(payer.publicKey, 2_000_000_000)
    .catch(e => console.error(e));

  const tx = await wh.transferNativeSol(
    conn,
    nnull(solanaConfig.bridgeAddress),
    nnull(solanaConfig.tokenBridgeAddress),
    payer.publicKey,
    BigInt(100_000_000),
    wh.tryNativeToUint8Array(nnull(fujiConfig.bridgeAddress), 6),
    fujiConfig.chainId,
  );
  tx.partialSign(payer);

  const txSig = await web3.sendAndConfirmRawTransaction(conn, tx.serialize(), {
    skipPreflight: true,
  });
  console.log(txSig);
  const rx = nnull(await conn.getTransaction(txSig));
  const seq = wh.parseSequenceFromLogSolana(rx);
  console.log(seq);

  if (process.argv[2] == "loop") {
    while (true) {
      await sleep(10_000);
      console.log("sending...");
      try {
        const tx = await wh.transferNativeSol(
          conn,
          nnull(solanaConfig.bridgeAddress),
          nnull(solanaConfig.tokenBridgeAddress),
          payer.publicKey,
          BigInt(100_000_000),
          wh.tryNativeToUint8Array(nnull(fujiConfig.bridgeAddress), 6),
          fujiConfig.chainId,
        );
        tx.partialSign(payer);

        web3
          .sendAndConfirmRawTransaction(conn, tx.serialize(), {
            skipPreflight: true,
          })
          .catch(() => {});

        conn.requestAirdrop(payer.publicKey, 2_000_000_000).catch(() => {});
      } catch (e) {
        console.log("error");
        console.log(e);
      }
    }
  } else {
    let times = Number(process.argv[2]);
    if (times > 1) {
      console.log(`Sending ${times} messages`);
      for (let i = 1; i < times; i++) {
        const tx = await wh.transferNativeSol(
          conn,
          nnull(solanaConfig.bridgeAddress),
          nnull(solanaConfig.tokenBridgeAddress),
          payer.publicKey,
          BigInt(100_000_000),
          wh.tryNativeToUint8Array(nnull(fujiConfig.bridgeAddress), 6),
          fujiConfig.chainId,
        );
        tx.partialSign(payer);

        web3.sendAndConfirmRawTransaction(conn, tx.serialize(), {
          skipPreflight: true,
        });
      }
    }
  }

  for (let i = 0; i < 15; i++) {
    try {
      const vaa = await wh.getSignedVAA(
        "https://wormhole-v2-testnet-api.certus.one",
        "solana",
        await wh.getEmitterAddressSolana(
          nnull(solanaConfig.tokenBridgeAddress),
        ),
        seq,
      );
      console.log(vaa);
    } catch (e) {
      console.error(i);
    }
    await sleep(1_000);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
