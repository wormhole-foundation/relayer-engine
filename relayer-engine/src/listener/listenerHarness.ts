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
    return await wormholeSdk.getEmitterAddressSolana(emitterAddressStr);
  }
  if (wormholeSdk.isTerraChain(myChainId)) {
    return await wormholeSdk.getEmitterAddressTerra(emitterAddressStr);
  }
  if (wormholeSdk.isEVMChain(myChainId)) {
    return wormholeSdk.getEmitterAddressEth(emitterAddressStr);
  }
  throw new Error(`Unrecognized wormhole chainId ${myChainId}`);
}
