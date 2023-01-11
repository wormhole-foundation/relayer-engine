import {
  CHAIN_ID_SOLANA,
  EVMChainId,
  isEVMChain,
  solana,
} from "@certusone/wormhole-sdk";
import { Connection } from "@solana/web3.js";
import { ethers } from "ethers";
import { ChainConfigInfo, Providers } from "relayer-plugin-interface";

export function providersFromChainConfig(
  chainConfigs: ChainConfigInfo[],
): Providers {
  const evmEntries: [EVMChainId, ethers.providers.JsonRpcProvider][] =
    chainConfigs.flatMap(chain => {
      if (isEVMChain(chain.chainId)) {
        return [
          [chain.chainId, new ethers.providers.JsonRpcProvider(chain.nodeUrl)],
        ];
      }
      return [];
    });
  const evm = Object.fromEntries(evmEntries) as {
    [id in EVMChainId]: ethers.providers.JsonRpcProvider;
  };

  let solanaUrl = chainConfigs.find(
    info => info.chainId === CHAIN_ID_SOLANA,
  )?.nodeUrl;
  if (!solanaUrl) {
    // todo: change me!!!!!!
    solanaUrl = "http://localhost:8899";
    // todo: generalize this
    // throw new Error("Expected solana rpc url to be defined");
  }
  return {
    evm,
    solana: new Connection(solanaUrl, "confirmed"),
  };
}
