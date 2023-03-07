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
} from "../../packages/relayer-plugin-interface";
import { Storage } from "../storage";
import * as wh from "@certusone/wormhole-sdk";
import { ChainId } from "@certusone/wormhole-sdk";
import { Queue } from "@datastructures-js/queue";
import { createWalletToolbox } from "./walletToolBox";
import { providersFromChainConfig } from "../utils/providers";
import { nnull, sleep } from "../utils/utils";
import { Logger } from "winston";
import {
  completedWorkflows,
  executedWorkflows,
  executingTimeSeconds,
  failedWorkflows,
  inProgressWorkflowsGauge,
  inQueueTimeSeconds,
  maxActiveWorkflowsGauge,
} from "./metrics";

// todo: add to config
const DEFAULT_WORKER_RESTART_MS = 10 * 1000;
const DEFAULT_WORKER_INTERVAL_MS = 500;
export const MAX_ACTIVE_WORKFLOWS = 10;
// const SPAWN_WORKFLOW_INTERNAL = 500;
const SPAWN_WORKFLOW_INTERNAL = 2000;

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

const sec = 1000;
const min = 60 * sec;

export async function run(plugins: Plugin[], storage: Storage) {
  const executorEnv = getExecutorEnv();
  const commonEnv = getCommonEnv();
  const logger = getScopedLogger(["executorHarness"], getLogger());

  const providers = providersFromChainConfig(commonEnv.supportedChains);

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
  logger.debug("Finished gathering worker infos.", { info: workerInfoMap });

  maxActiveWorkflowsGauge.set(MAX_ACTIVE_WORKFLOWS);
  spawnStaleJobsWorker(storage, 1000, logger);
  spawnRequeueWorker(storage, 150, logger);
  spawnHeartbeatWorker(storage, 1000, logger);
  spawnExecutor(storage, plugins, providers, workerInfoMap, logger);
}

async function spawnHeartbeatWorker(
  storage: Storage,
  checkEveryInMs: number,
  logger: Logger,
) {
  while (true) {
    await storage.emitHeartbeat();
    await sleep(checkEveryInMs);
  }
}

async function spawnRequeueWorker(
  storage: Storage,
  checkEveryInMs: number,
  logger: Logger,
) {
  while (true) {
    const jobsMoved = await storage.moveDelayedWorkflowsToReadyQueue();
    if (jobsMoved > 0) {
      logger.info(`Moved ${jobsMoved} to the ready queue.`);
    }
    await sleep(checkEveryInMs);
  }
}

async function spawnStaleJobsWorker(
  storage: Storage,
  checkEveryInMs: number,
  logger: Logger,
) {
  while (true) {
    const jobsMoved = await storage.cleanupStaleActiveWorkflows();
    if (jobsMoved > 0) {
      logger.info(`Moved ${jobsMoved} stale jobs.`);
    }
    await sleep(checkEveryInMs);
  }
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
      let inProgressWorkflows = await storage.numActiveWorkflows();
      inProgressWorkflowsGauge.set(inProgressWorkflows);

      if (inProgressWorkflows >= MAX_ACTIVE_WORKFLOWS) {
        await sleep(SPAWN_WORKFLOW_INTERNAL);
        continue;
      }
      const res = await storage.getNextWorkflow(1);
      if (!res) {
        logger.debug("No new workflows found.");
        continue;
      }
      const workflowLogger = logger.child({
        workflowId: res.workflow.id,
        pluginName: res.plugin.pluginName,
        emitterChain: res.workflow.emitterChain,
        emitterAddress: res.workflow.emitterAddress,
        sequence: res.workflow.sequence,
      });

      workflowLogger.debug("New workflow found");
      const { workflow, plugin } = res;

      try {
        await spawnWorkflow(
          storage,
          workflow,
          plugin,
          providers,
          actionQueues,
          workflowLogger,
        );
      } catch (e) {
        workflowLogger.error("Workflow failed to spawn", e);
      }
    } catch (e) {
      getLogger().error("Workflow failed to spawn", e);
    }
  }
}

function exponentialBackoff(
  retryCount: number,
  minDelayInMs: number,
  maxDelayInMs: number,
) {
  const delay = minDelayInMs * Math.pow(2, retryCount);
  return Math.min(maxDelayInMs, delay);
}

async function spawnWorkflow(
  storage: Storage,
  workflow: Workflow,
  plugin: Plugin,
  providers: Providers,
  actionQueues: Map<ChainId, Queue<ActionWithCont<any, any>>>,
  workflowLogger: ScopedLogger,
): Promise<void> {
  workflowLogger.info(`Starting workflow.`);
  // Metrics: Start execution timer & record time in queue.
  const stopExecutionTimer = executingTimeSeconds.startTimer({
    plugin: plugin.pluginName,
  });
  executedWorkflows.labels({ plugin: plugin.pluginName }).inc();
  if (workflow.scheduledAt) {
    let now = new Date();
    const timeInQueue = (now.getTime() - workflow.scheduledAt.getTime()) / 1000;
    inQueueTimeSeconds.observe(timeInQueue);
  }
  // End metrics setup.

  const execute = makeExecuteFunc(
    actionQueues,
    plugin.pluginName,
    workflowLogger,
  );

  // fire off workflow and avoid blocking
  const result = (async () => {
    try {
      await plugin.handleWorkflow(workflow, providers, execute);

      await storage.completeWorkflow(workflow);

      // Metrics & logging
      workflowLogger.info(`Finished executing workflow.`);
      completedWorkflows.labels({ plugin: plugin.pluginName }).inc();
    } catch (err: any) {
      workflow.errorMessage = err.message;
      workflow.errorStacktrace = err.stack;

      workflowLogger.error(`Workflow errored`, err);
      failedWorkflows.labels({ plugin: plugin.pluginName }).inc();

      if (workflow.maxRetries! > workflow.retryCount) {
        const waitFor = exponentialBackoff(workflow.retryCount, 300, 10 * min);
        const reExecuteAt = new Date(Date.now() + waitFor);
        await storage.requeueWorkflow(workflow, reExecuteAt);
        workflowLogger.error(
          `Workflow failed. Requeued with a delay of ${waitFor}ms. Attempt ${workflow.retryCount} of ${workflow.maxRetries}`,
        );
      } else {
        await storage.failWorkflow(workflow);
        workflowLogger.error(
          `Workflow failed. Reached maxRetries (${workflow.maxRetries}). Moving to dead letter queue.`,
        );
      }
    } finally {
      stopExecutionTimer();
    }
  })();
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
        logger.error(
          `Error making execute function. Unsupported chain: ${action.chainId}`,
        );
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
        continue;
      }
      const actionWithCont = actionQueue.dequeue();
      logger.info(`Relaying action for plugin ${actionWithCont.pluginName}...`);

      try {
        const result = await actionWithCont.action.f(
          walletToolBox,
          workerInfo.targetChainId,
        );
        logger.info(`Action ${actionWithCont.pluginName} completed`, {
          action: actionWithCont,
        });
        actionWithCont.resolve(result);
      } catch (e) {
        logger.error(`Unexpected error while executing chain action:`, e);
        actionWithCont.reject(e);
      }
    } catch (e) {
      logger.error("", e);
      // wait longer between loop iterations on error
      await sleep(DEFAULT_WORKER_RESTART_MS);
    }
  }
}
