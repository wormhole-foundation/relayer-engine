import { Providers } from "../providers.middleware";
import { Logger } from "winston";
import { Queue } from "@datastructures-js/queue";
import { createWalletToolbox } from "./walletToolBox";
import { sleep } from "../../application";
import { ActionWithCont, WorkerInfo } from "./wallet.middleware";

const DEFAULT_WORKER_RESTART_MS = 10 * 1000;
const DEFAULT_WORKER_INTERVAL_MS = 500;

export async function spawnWalletWorker(
  actionQueue: Queue<ActionWithCont<any, any>>,
  providers: Providers,
  workerInfo: WorkerInfo,
  logger: Logger
): Promise<void> {
  logger.info(`Spawned`);
  const workerIntervalMS = DEFAULT_WORKER_INTERVAL_MS;
  const walletToolBox = createWalletToolbox(
    providers,
    workerInfo.walletPrivateKey,
    workerInfo.targetChainId
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
          workerInfo.targetChainId
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
