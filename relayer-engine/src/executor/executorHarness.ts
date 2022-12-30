import { getCommonEnv, getExecutorEnv } from "../config";
import { getLogger, getScopedLogger, ScopedLogger } from "../helpers/logHelper";
import {
  Action,
  EVMWallet,
  Plugin,
  Providers,
  SolanaWallet,
  ActionExecutor,
  Wallet,
  ActionFunc,
  Workflow,
} from "relayer-plugin-interface";
import * as solana from "@solana/web3.js";
import { Storage, WorkflowWithPlugin } from "../storage";
import * as wh from "@certusone/wormhole-sdk";
import * as ethers from "ethers";
import { ChainId, EVMChainId } from "@certusone/wormhole-sdk";
import { Queue } from "@datastructures-js/queue";
import { createWalletToolbox } from "./walletToolBox";
import { providersFromChainConfig } from "../utils/providers";
import { nnull, sleep } from "../utils/utils";
import { Logger } from "winston";

// todo: add to config
const DEFAULT_WORKER_RESTART_MS = 10 * 1000;
const DEFAULT_WORKER_INTERVAL_MS = 500;
const MAX_ACTIVE_WORKFLOWS = 10;
const SPAWN_WORKFLOW_INTERNAL = 500;

export interface WorkerInfo {
  id: number;
  targetChainId: wh.ChainId;
  targetChainName: string;
  walletPrivateKey: string;
}

export interface ActionWithCont<T, W extends Wallet> {
  action: Action<T, W>;
  pluginName: string;
  resolve: (t: T) => void;
  reject: (reason: any) => void;
}

export async function run(plugins: Plugin[], storage: Storage) {
  const executorEnv = getExecutorEnv();
  const commonEnv = getCommonEnv();
  const logger = getScopedLogger(["executorHarness"], getLogger());

  await storage.handleStorageStartupConfig(plugins);
  const providers = providersFromChainConfig(commonEnv.supportedChains);

  logger.debug("Gathering chain worker infos...");
  const workerInfoMap = new Map<ChainId, WorkerInfo[]>(
    commonEnv.supportedChains.map(chain => {
      //TODO update for all ecosystems
      const workerInfos = executorEnv.privateKeys[chain.chainId].map(
        (key, id) => ({
          id,
          targetChainId: chain.chainId,
          targetChainName: chain.chainName,
          walletPrivateKey: nnull(
            key,
            `privateKey for chain ${chain.chainName}`,
          ),
        }),
      );
      return [chain.chainId, workerInfos];
    }),
  );
  await spawnExecutor(storage, plugins, providers, workerInfoMap, logger);
}

async function spawnExecutor(
  storage: Storage,
  plugins: Plugin[],
  providers: Providers,
  workerInfoMap: Map<ChainId, WorkerInfo[]>,
  logger: ScopedLogger,
): Promise<void> {
  const actionQueues = spawnWalletWorkers(providers, workerInfoMap);

  while (true) {
    try {
      if ((await storage.numActiveWorkflows()) < MAX_ACTIVE_WORKFLOWS) {
        await sleep(SPAWN_WORKFLOW_INTERNAL);
        continue;
      }
      // TODO
      const res = await storage.getNextWorkflow(1);
      if (!res) {
        logger.debug("No new workflows found");
        continue;
      }
      // After getting a workflow due to racing conditions we may be attempting to process more than MAX, if so, requeue and try again
      // if ((await storage.numActiveWorkflows()) < MAX_ACTIVE_WORKFLOWS) {
      //   await storage.requeueWorkflow(res.workflow);
      //   continue;
      // }
      // Commented out because this can cause if DOS if multiple instances requeue at the same time over and over
      const { workflow, plugin } = res;

      await spawnWorkflow(
        storage,
        workflow,
        plugin,
        providers,
        actionQueues,
        logger,
      );
    } catch (e) {
      getLogger().error("Workflow failed to spawn");
      getLogger().error(e);
      getLogger().error(JSON.stringify(e));
    }
  }
}

async function spawnWorkflow(
  storage: Storage,
  workflow: Workflow,
  plugin: Plugin,
  providers: Providers,
  actionQueues: Map<ChainId, Queue<ActionWithCont<any, any>>>,
  logger: ScopedLogger,
): Promise<void> {
  logger.info(
    `Starting workflow ${workflow.id} for plugin ${workflow.pluginName}`,
  );
  const execute = makeExecuteFunc(actionQueues, plugin.pluginName, logger);
  try {
    await plugin.handleWorkflow(workflow, providers, execute);
    await storage.completeWorkflow(workflow);
    logger.info(
      `Finished workflow ${workflow.id} for plugin ${workflow.pluginName}`,
    );
  } catch (e) {
    logger.warn(
      `Workflow ${workflow.id} for plugin ${workflow.pluginName} errored:`,
    );
    logger.error(e);
    await storage.requeueWorkflow(workflow);
  }
}

function makeExecuteFunc(
  actionQueues: Map<ChainId, Queue<ActionWithCont<any, any>>>,
  pluginName: string,
  logger: Logger,
): ActionExecutor {
  // push action onto actionQueue and have worker reject or resolve promise
  const func = <T, W extends Wallet>(action: Action<T, W>): Promise<T> => {
    return new Promise((resolve, reject) => {
      const maybeQueue = actionQueues.get(action.chainId);
      if (!maybeQueue) {
        logger.error("Chain not supported: " + action.chainId);
        return reject("Chain not supported");
      }
      maybeQueue.enqueue({
        action,
        pluginName,
        resolve,
        reject,
      });
    });
  };
  func.onSolana = <T>(f: ActionFunc<T, SolanaWallet>) =>
    func({ chainId: wh.CHAIN_ID_SOLANA, f });
  func.onEVM = <T>(action: Action<T, EVMWallet>) => func(action);
  return func;
}

function spawnWalletWorkers(
  providers: Providers,
  workerInfoMap: Map<ChainId, WorkerInfo[]>,
): Map<ChainId, Queue<ActionWithCont<any, any>>> {
  const actionQueues = new Map<ChainId, Queue<ActionWithCont<any, any>>>();
  // spawn worker for each wallet
  for (const [chain, workerInfos] of workerInfoMap.entries()) {
    const actionQueue = new Queue<ActionWithCont<any, any>>();
    actionQueues.set(chain, actionQueue);
    workerInfos.forEach(info =>
      spawnWalletWorker(actionQueue, providers, info),
    );
  }
  return actionQueues;
}

async function spawnWalletWorker(
  actionQueue: Queue<ActionWithCont<any, any>>,
  providers: Providers,
  workerInfo: WorkerInfo,
): Promise<void> {
  const logger = getScopedLogger(
    [`${workerInfo.targetChainName}-${workerInfo.id}-worker`],
    getLogger(),
  );
  logger.info(`Spawned`);
  const workerIntervalMS =
    getExecutorEnv().actionInterval || DEFAULT_WORKER_INTERVAL_MS;
  const walletToolBox = createWalletToolbox(
    providers,
    workerInfo.walletPrivateKey,
    workerInfo.targetChainId,
  );
  while (true) {
    // always sleep between loop iterations
    await sleep(workerIntervalMS);

    try {
      if (actionQueue.isEmpty()) {
        logger.debug("No action found, sleeping...");
        continue;
      }
      const actionWithCont = actionQueue.dequeue();
      logger.info(`Relaying action for plugin ${actionWithCont.pluginName}...`);

      try {
        const result = await actionWithCont.action.f(
          walletToolBox,
          workerInfo.targetChainId,
        );
        logger.info(`Action ${actionWithCont.pluginName} completed`);
        actionWithCont.resolve(result);
      } catch (e) {
        logger.error(e);
        logger.warn(`Unexpected error while executing chain action:`);
        actionWithCont.reject(e);
      }
    } catch (e) {
      logger.error(e);
      // wait longer between loop iterations on error
      await sleep(DEFAULT_WORKER_RESTART_MS);
    }
  }
}
