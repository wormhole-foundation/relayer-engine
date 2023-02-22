import { getCommonEnv, getListenerEnv } from "../config";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import {
  ContractFilter,
  Plugin,
} from "../../packages/relayer-plugin-interface";
import { Storage } from "../storage";
import { providersFromChainConfig } from "../utils/providers";
import { createSpyEventSource } from "./spyEventSource";
import * as wormholeSdk from "@certusone/wormhole-sdk";
import { nextVaaFetchingWorker } from "./missedVaaFetching";

let _logger: ScopedLogger;
const logger = () => {
  if (!_logger) {
    _logger = getScopedLogger(["listenerHarness"]);
  }
  return _logger;
};

export async function run(plugins: Plugin[], storage: Storage) {
  const commonEnv = getCommonEnv();
  const providers = providersFromChainConfig(commonEnv.supportedChains);

  if (shouldSpy(plugins)) {
    logger().info("Initializing spy listener...");
    createSpyEventSource(plugins, storage, providers);
    nextVaaFetchingWorker(plugins, storage, providers);
  }

  if (shouldRest(plugins)) {
    logger().warn(`Rest listener interface not yet implemented`);
    //const restListener = setupRestListener(restFilters);
  }
  logger().debug("End of listener harness run function");
}

function shouldRest(plugins: Plugin[]): boolean {
  return plugins.some(x => x.shouldRest);
}

function shouldSpy(plugins: Plugin[]): boolean {
  return plugins.some(x => x.shouldSpy);
}

export async function transformEmitterFilter(
  x: ContractFilter,
): Promise<ContractFilter> {
  return {
    chainId: x.chainId,
    emitterAddress: await encodeEmitterAddress(x.chainId, x.emitterAddress),
  };
}

async function encodeEmitterAddress(
  myChainId: wormholeSdk.ChainId,
  emitterAddressStr: string,
): Promise<string> {
  if (
    myChainId === wormholeSdk.CHAIN_ID_SOLANA ||
    myChainId === wormholeSdk.CHAIN_ID_PYTHNET
  ) {
    return wormholeSdk.getEmitterAddressSolana(emitterAddressStr);
  }
  if (wormholeSdk.isTerraChain(myChainId)) {
    return wormholeSdk.getEmitterAddressTerra(emitterAddressStr);
  }
  if (wormholeSdk.isEVMChain(myChainId)) {
    return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
  }
  if (wormholeSdk.CHAIN_ID_ALGORAND === myChainId) {
    return wormholeSdk.getEmitterAddressAlgorand(BigInt(emitterAddressStr))
  }
  if (wormholeSdk.CHAIN_ID_INJECTIVE === myChainId) {
    return wormholeSdk.getEmitterAddressInjective(emitterAddressStr)
  }
  if (wormholeSdk.CHAIN_ID_NEAR === myChainId) {
    return wormholeSdk.getEmitterAddressNear(emitterAddressStr)
  }
  if (wormholeSdk.CHAIN_ID_XPLA === myChainId) {
    return wormholeSdk.getEmitterAddressXpla(emitterAddressStr)
  }
  throw new Error(`Encoding emitter address not implemented for wormhole chainId ${myChainId}`);
}
