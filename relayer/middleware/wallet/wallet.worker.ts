import { Providers } from "../providers.middleware";
import { Logger } from "winston";
import { Queue } from "@datastructures-js/queue";
import { createWalletToolbox } from "./walletToolBox";
import { ActionWithCont, WorkerInfo } from "./wallet.middleware";
import { sleep } from "../../utils";

const DEFAULT_WORKER_RESTART_MS = 2 * 1000;
const DEFAULT_WORKER_INTERVAL_MS = 1;

export async function spawnWalletWorker(
  actionQueue: Queue<ActionWithCont<any, any>>,
  providers: Providers,
  workerInfo: WorkerInfo,
  logger: Logger,
): Promise<void> {
  const workerIntervalMS = DEFAULT_WORKER_INTERVAL_MS;
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

      try {
        const result = await actionWithCont.action.f(
          walletToolBox,
          workerInfo.targetChainId,
        );
        logger.debug(`Action ${actionWithCont.pluginName} completed`, {
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
