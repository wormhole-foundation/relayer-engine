"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wallets = void 0;
const wormhole_sdk_1 = require("@certusone/wormhole-sdk");
const wallet_worker_1 = require("./wallet.worker");
const queue_1 = require("@datastructures-js/queue");
function makeExecuteFunc(actionQueues, pluginName, logger) {
    // push action onto actionQueue and have worker reject or resolve promise
    const func = (chainId, f) => {
        return new Promise((resolve, reject) => {
            const maybeQueue = actionQueues.get(chainId);
            if (!maybeQueue) {
                logger?.error(`Error making execute function. Unsupported chain: ${chainId}`);
                return reject("Chain not supported");
            }
            maybeQueue.enqueue({
                action: { chainId, f },
                pluginName,
                resolve,
                reject,
            });
        });
    };
    func.onSolana = (f) => func(wormhole_sdk_1.CHAIN_ID_SOLANA, f);
    func.onEVM = (chainId, f) => func(chainId, f);
    return func;
}
function wallets(opts) {
    const workerInfoMap = new Map(Object.entries(opts.privateKeys).map(([chainIdStr, keys]) => {
        //TODO update for all ecosystems
        let chainId = Number(chainIdStr);
        const workerInfos = keys.map((key, id) => ({
            id,
            targetChainId: chainId,
            targetChainName: wormhole_sdk_1.CHAIN_ID_TO_NAME[chainId],
            walletPrivateKey: key,
        }));
        return [chainId, workerInfos];
    }));
    let executeFunction;
    return async (ctx, next) => {
        if (!executeFunction) {
            ctx.logger?.debug(`Initializing wallets...`);
            const actionQueues = new Map();
            for (const [chain, workerInfos] of workerInfoMap.entries()) {
                const actionQueue = new queue_1.Queue();
                actionQueues.set(chain, actionQueue);
                workerInfos.forEach((info) => (0, wallet_worker_1.spawnWalletWorker)(actionQueue, ctx.providers, info, opts.logger));
            }
            executeFunction = makeExecuteFunc(actionQueues, opts.namespace ?? "default", opts.logger);
            ctx.logger?.debug(`Initialized wallets`);
        }
        ctx.wallets = executeFunction;
        await next();
    };
}
exports.wallets = wallets;
//# sourceMappingURL=wallet.middleware.js.map