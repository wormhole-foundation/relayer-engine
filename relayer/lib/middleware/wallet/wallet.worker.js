"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnWalletWorker = void 0;
const walletToolBox_1 = require("./walletToolBox");
const application_1 = require("../../application");
const DEFAULT_WORKER_RESTART_MS = 10 * 1000;
const DEFAULT_WORKER_INTERVAL_MS = 500;
async function spawnWalletWorker(actionQueue, providers, workerInfo, logger) {
    logger.info(`Spawned`);
    const workerIntervalMS = DEFAULT_WORKER_INTERVAL_MS;
    const walletToolBox = (0, walletToolBox_1.createWalletToolbox)(providers, workerInfo.walletPrivateKey, workerInfo.targetChainId);
    while (true) {
        // always sleep between loop iterations
        await (0, application_1.sleep)(workerIntervalMS);
        try {
            if (actionQueue.isEmpty()) {
                continue;
            }
            const actionWithCont = actionQueue.dequeue();
            logger.info(`Relaying action for plugin ${actionWithCont.pluginName}...`);
            try {
                const result = await actionWithCont.action.f(walletToolBox, workerInfo.targetChainId);
                logger.info(`Action ${actionWithCont.pluginName} completed`, {
                    action: actionWithCont,
                });
                actionWithCont.resolve(result);
            }
            catch (e) {
                logger.error(`Unexpected error while executing chain action:`, e);
                actionWithCont.reject(e);
            }
        }
        catch (e) {
            logger.error("", e);
            // wait longer between loop iterations on error
            await (0, application_1.sleep)(DEFAULT_WORKER_RESTART_MS);
        }
    }
}
exports.spawnWalletWorker = spawnWalletWorker;
//# sourceMappingURL=wallet.worker.js.map