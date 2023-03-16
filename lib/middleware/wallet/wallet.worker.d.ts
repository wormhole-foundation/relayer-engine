import { Providers } from "../providers.middleware";
import { Logger } from "winston";
import { Queue } from "@datastructures-js/queue";
import { ActionWithCont, WorkerInfo } from "./wallet.middleware";
export declare function spawnWalletWorker(actionQueue: Queue<ActionWithCont<any, any>>, providers: Providers, workerInfo: WorkerInfo, logger: Logger): Promise<void>;
