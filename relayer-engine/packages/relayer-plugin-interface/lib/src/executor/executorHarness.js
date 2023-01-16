"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = exports.MAX_ACTIVE_WORKFLOWS = void 0;
const config_1 = require("../config");
const logHelper_1 = require("../helpers/logHelper");
const wh = require("@certusone/wormhole-sdk");
const queue_1 = require("@datastructures-js/queue");
const walletToolBox_1 = require("./walletToolBox");
const providers_1 = require("../utils/providers");
const utils_1 = require("../utils/utils");
const metrics_1 = require("./metrics");
// todo: add to config
const DEFAULT_WORKER_RESTART_MS = 10 * 1000;
const DEFAULT_WORKER_INTERVAL_MS = 500;
exports.MAX_ACTIVE_WORKFLOWS = 10;
// const SPAWN_WORKFLOW_INTERNAL = 500;
const SPAWN_WORKFLOW_INTERNAL = 2000;
async function run(plugins, storage) {
    const executorEnv = (0, config_1.getExecutorEnv)();
    const commonEnv = (0, config_1.getCommonEnv)();
    const logger = (0, logHelper_1.getScopedLogger)(["executorHarness"], (0, logHelper_1.getLogger)());
    await storage.handleStorageStartupConfig(plugins);
    const providers = (0, providers_1.providersFromChainConfig)(commonEnv.supportedChains);
    logger.debug("Gathering chain worker infos...");
    const workerInfoMap = new Map(commonEnv.supportedChains.map(chain => {
        //TODO update for all ecosystems
        const workerInfos = executorEnv.privateKeys[chain.chainId].map((key, id) => ({
            id,
            targetChainId: chain.chainId,
            targetChainName: chain.chainName,
            walletPrivateKey: (0, utils_1.nnull)(key, `privateKey for chain ${chain.chainName}`),
        }));
        return [chain.chainId, workerInfos];
    }));
    metrics_1.maxActiveWorkflowsGauge.set(exports.MAX_ACTIVE_WORKFLOWS);
    spawnRequeueWorker(storage, 100, logger);
    spawnExecutor(storage, plugins, providers, workerInfoMap, logger);
    logger.debug("End of executor harness run function");
}
exports.run = run;
async function spawnRequeueWorker(storage, delayInMs, logger) {
    while (true) {
        const jobsMoved = await storage.moveWorkflowsToReadyQueue();
        if (jobsMoved > 0) {
            logger.info(`Moved ${jobsMoved} to the ready queue.`);
        }
        await (0, utils_1.sleep)(delayInMs);
    }
}
async function spawnExecutor(storage, plugins, providers, workerInfoMap, logger) {
    const actionQueues = spawnWalletWorkers(providers, workerInfoMap);
    while (true) {
        try {
            let inProgressWorkflows = await storage.numActiveWorkflows();
            metrics_1.inProgressWorkflowsGauge.set(inProgressWorkflows);
            if (inProgressWorkflows >= exports.MAX_ACTIVE_WORKFLOWS) {
                await (0, utils_1.sleep)(SPAWN_WORKFLOW_INTERNAL);
                continue;
            }
            // TODO
            const res = await storage.getNextWorkflow(1);
            if (!res) {
                logger.debug("No new workflows found");
                continue;
            }
            const { workflow, plugin } = res;
            await spawnWorkflow(storage, workflow, plugin, providers, actionQueues, logger);
        }
        catch (e) {
            (0, logHelper_1.getLogger)().error("Workflow failed to spawn");
            (0, logHelper_1.getLogger)().error(e);
            (0, logHelper_1.getLogger)().error(JSON.stringify(e));
        }
    }
}
function exponentialBackoff(retryCount, minDelayInMs, maxDelayInMs) {
    const delay = minDelayInMs * Math.pow(2, retryCount);
    return Math.min(maxDelayInMs, delay);
}
async function spawnWorkflow(storage, workflow, plugin, providers, actionQueues, logger) {
    const finishedExecuting = metrics_1.executingTimeSeconds.startTimer({
        plugin: plugin.pluginName,
    });
    logger.info(`Starting workflow ${workflow.id} for plugin ${workflow.pluginName}`);
    // Record metrics
    metrics_1.executedWorkflows.labels({ plugin: plugin.pluginName }).inc();
    if (workflow.scheduledAt) {
        let now = new Date();
        const timeInQueue = (now.getTime() - workflow.scheduledAt.getTime()) / 1000;
        metrics_1.inQueueTimeSeconds.observe(timeInQueue);
    }
    const execute = makeExecuteFunc(actionQueues, plugin.pluginName, logger);
    // fire off workflow and avoid blocking
    const result = (async () => {
        try {
            await plugin.handleWorkflow(workflow, providers, execute);
            await storage.completeWorkflow(workflow);
            logger.info(`Finished workflow ${workflow.id} for plugin ${workflow.pluginName}`);
            metrics_1.completedWorkflows.labels({ plugin: plugin.pluginName }).inc();
        }
        catch (e) {
            logger.warn(`Workflow ${workflow.id} for plugin ${workflow.pluginName} errored:`);
            logger.error(e);
            metrics_1.failedWorkflows.labels({ plugin: plugin.pluginName }).inc();
            if (workflow.maxRetries > workflow.retryCount) {
                const waitFor = plugin.getRetryDelayInMS?.(workflow.retryCount, workflow.maxRetries) ??
                    exponentialBackoff(workflow.retryCount, workflow.maxRetries, 1000);
                const now = new Date();
                const reExecuteAt = new Date(now.getTime() + waitFor);
                workflow.retryCount++;
                await storage.requeueWorkflow(workflow, reExecuteAt);
                logger.error(`Workflow: ${workflow.id} failed. Requeued with a delay of ${waitFor}ms. Attempt ${workflow.retryCount} of ${workflow.maxRetries}`);
            }
            else {
            }
        }
        finally {
            finishedExecuting();
        }
    })();
}
function makeExecuteFunc(actionQueues, pluginName, logger) {
    // push action onto actionQueue and have worker reject or resolve promise
    const func = (action) => {
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
    func.onSolana = (f) => func({ chainId: wh.CHAIN_ID_SOLANA, f });
    func.onEVM = (action) => func(action);
    return func;
}
function spawnWalletWorkers(providers, workerInfoMap) {
    const actionQueues = new Map();
    // spawn worker for each wallet
    for (const [chain, workerInfos] of workerInfoMap.entries()) {
        const actionQueue = new queue_1.Queue();
        actionQueues.set(chain, actionQueue);
        workerInfos.forEach(info => spawnWalletWorker(actionQueue, providers, info));
    }
    return actionQueues;
}
async function spawnWalletWorker(actionQueue, providers, workerInfo) {
    const logger = (0, logHelper_1.getScopedLogger)([`${workerInfo.targetChainName}-${workerInfo.id}-worker`], (0, logHelper_1.getLogger)());
    logger.info(`Spawned`);
    const workerIntervalMS = (0, config_1.getExecutorEnv)().actionInterval || DEFAULT_WORKER_INTERVAL_MS;
    const walletToolBox = (0, walletToolBox_1.createWalletToolbox)(providers, workerInfo.walletPrivateKey, workerInfo.targetChainId);
    while (true) {
        // always sleep between loop iterations
        await (0, utils_1.sleep)(workerIntervalMS);
        try {
            if (actionQueue.isEmpty()) {
                continue;
            }
            const actionWithCont = actionQueue.dequeue();
            logger.info(`Relaying action for plugin ${actionWithCont.pluginName}...`);
            try {
                const result = await actionWithCont.action.f(walletToolBox, workerInfo.targetChainId);
                logger.info(`Action ${actionWithCont.pluginName} completed`);
                actionWithCont.resolve(result);
            }
            catch (e) {
                logger.error(e);
                logger.warn(`Unexpected error while executing chain action:`);
                actionWithCont.reject(e);
            }
        }
        catch (e) {
            logger.error(e);
            // wait longer between loop iterations on error
            await (0, utils_1.sleep)(DEFAULT_WORKER_RESTART_MS);
        }
    }
}
//# sourceMappingURL=executorHarness.js.map