import { CHAIN_ID_SOLANA, isEVMChain, isTerraChain } from "@certusone/wormhole-sdk";
import { ChainConfigInfo } from "../../packages/relayer-plugin-interface";
import { getCommonEnv, CommonEnv, ExecutorEnv, getExecutorEnv, PrivateKeys, TokenMonitoringInfo } from "../config";
import { getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import { sleep } from "../utils/utils"
import { WalletBalance, pullAllSolanaBalances, pullAllEVMBalances, pullAllTerraBalances } from './balances';
import { updateWalletBalances } from "./metrics";

const ONE_MINUTE: number = 60000;

let _logger: ScopedLogger;

const logger = () => {
  if (!_logger) _logger = getScopedLogger(["WalletMonitor"]);
  return _logger;
}

export type ChainMonitoringConfig = {
  chainInfo: ChainConfigInfo,
  privateKeys: string[],
}

async function pullBalances(monitorConfig: ChainMonitoringConfig[], tokensToMonitor: TokenMonitoringInfo[]): Promise<WalletBalance[]> {
  const balancePromises: Promise<WalletBalance[]>[] = [];

  for (const { chainInfo, privateKeys } of monitorConfig) {
    switch (true) {
      case chainInfo.chainId === CHAIN_ID_SOLANA:
        balancePromises.push(pullAllSolanaBalances(chainInfo, privateKeys));
        break;

      case isEVMChain(chainInfo.chainId):
        balancePromises.push(...pullAllEVMBalances(chainInfo, privateKeys, tokensToMonitor));
        break;

      case isTerraChain(chainInfo.chainId):
        pullAllTerraBalances(chainInfo, privateKeys, tokensToMonitor);
        break;

      default:
        logger().error("Invalid chain ID in wallet monitor " + chainInfo.chainId);
    }
  }

  const balances = await Promise.all(balancePromises);

  return balances.reduce((prev, curr) => [...prev, ...curr], []);
}

function getMonitoringConfig (supportedChains: ChainConfigInfo[], availablePrivateKeys: PrivateKeys): ChainMonitoringConfig[] {
  return supportedChains.map((chainInfo) => {
    return {
      chainInfo: chainInfo,
      privateKeys: availablePrivateKeys[chainInfo.chainId],
    };
  });
};
  
async function runWalletMonitor() {
  const commonEnv: CommonEnv = getCommonEnv();
  const executorEnv: ExecutorEnv = getExecutorEnv();
  
  const chainMonitoringConfig: ChainMonitoringConfig[] = getMonitoringConfig(commonEnv.supportedChains, executorEnv.privateKeys);
  
  logger().info("Running wallet monitor");

  while (true) {
    logger().debug("Pulling balances.");
    let balances: WalletBalance[] = [];
    try {
      balances = await pullBalances(chainMonitoringConfig, executorEnv.tokensToMonitor);
      updateWalletBalances(balances);
    } catch (e) {
      logger().error(`Failed to pullBalances: ${e}`);
    }
    await sleep(ONE_MINUTE);
  }
}

export async function spawnWalletMonitorWorker() {
  runWalletMonitor().catch(async (e) => {
    logger().error("Worker Failed with error:" + e);
    await sleep (ONE_MINUTE);
    spawnWalletMonitorWorker();
  });
}
