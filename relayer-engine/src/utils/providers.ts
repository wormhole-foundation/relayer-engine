import {
  CHAIN_ID_SOLANA,
  EVMChainId,
  isEVMChain,
  ChainId,
} from "@certusone/wormhole-sdk";
import { Connection } from "@solana/web3.js";
import { ethers } from "ethers";
import {
  ChainConfigInfo,
  Providers,
  UntypedProvider,
} from "../../packages/relayer-plugin-interface";

export function providersFromChainConfig(
  chainConfigs: ChainConfigInfo[],
): Providers {
  let providers = {
    evm: {} as Record<EVMChainId, ethers.providers.JsonRpcProvider>,
    untyped: {} as Record<ChainId, UntypedProvider>,
    solana: undefined as unknown as Connection,
  };

  for (const chain of chainConfigs) {
    if (isEVMChain(chain.chainId)) {
      providers.evm[chain.chainId] = new ethers.providers.JsonRpcProvider(
        chain.nodeUrl,
      );
    } else if (chain.chainId === CHAIN_ID_SOLANA) {
      providers.solana = new Connection(chain.nodeUrl);
    } else {
      providers.untyped[chain.chainId] = {
        rpcUrl: chain.nodeUrl,
      };
    }
  }
  return providers;
}
