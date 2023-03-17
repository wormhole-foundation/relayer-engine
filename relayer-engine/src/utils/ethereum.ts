import { ethers_contracts } from "@certusone/wormhole-sdk";
import { ethers } from "ethers";

export async function getEthereumToken(
  tokenAddress: string,
  provider: ethers.providers.Provider
) {
  const token = ethers_contracts.TokenImplementation__factory.connect(tokenAddress, provider);
  return token;
}
