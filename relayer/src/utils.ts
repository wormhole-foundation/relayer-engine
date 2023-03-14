import * as wormholeSdk from "@certusone/wormhole-sdk";
import { bech32 } from "bech32";
import { deriveWormholeEmitterKey } from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import { zeroPad } from "ethers/lib/utils";

export function encodeEmitterAddress(
  chainId: wormholeSdk.ChainId,
  emitterAddressStr: string
): string {
  if (
    chainId === wormholeSdk.CHAIN_ID_SOLANA ||
    chainId === wormholeSdk.CHAIN_ID_PYTHNET
  ) {
    return deriveWormholeEmitterKey(emitterAddressStr)
      .toBuffer()
      .toString("hex");
  }
  if (wormholeSdk.isCosmWasmChain(chainId)) {
    return Buffer.from(
      zeroPad(bech32.fromWords(bech32.decode(emitterAddressStr).words), 32)
    ).toString("hex");
  }
  if (wormholeSdk.isEVMChain(chainId)) {
    return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
  }
  if (wormholeSdk.CHAIN_ID_ALGORAND === chainId) {
    return wormholeSdk.getEmitterAddressAlgorand(BigInt(emitterAddressStr));
  }
  if (wormholeSdk.CHAIN_ID_NEAR === chainId) {
    return wormholeSdk.getEmitterAddressNear(emitterAddressStr);
  }
  throw new Error(`Unrecognized wormhole chainId ${chainId}`);
}

export function sleep(ms: number) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}
