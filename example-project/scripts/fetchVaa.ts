import { getEmitterAddressSolana, getSignedVAA } from "@certusone/wormhole-sdk";
import * as relayer_engine from "relayer-engine";

async function main() {
  const emitterAddress = "0x414De856795ecA8F0207D83d69C372Df799Ee377";
  const chainId = 16;
  const seq = "2";

  const vaa = await getSignedVAA(
    "https://wormhole-v2-testnet-api.certus.one",
    chainId,
    // await relayer_engine.encodeEmitterAddress(chainId, emitterAddress),
    "000000000000000000000000414de856795eca8f0207d83d69c372df799ee377",
    seq,
  );
  console.log(vaa);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
