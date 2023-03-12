/// <reference types="node" />
import { Job, Queue } from "bullmq";
import { RelayerApp } from "./application";
import { Context } from "./context";
import { Logger } from "winston";
export declare class StorageContext extends Context {
    job: Job;
}
export interface StorageOptions {
    queueName: string;
    attempts: number;
    namespace?: string;
}
export declare type JobData = {
    parsedVaa: any;
    vaaBytes: string;
};
export declare class Storage<T extends Context> {
    private relayer;
    private storageOptions;
    logger: Logger;
    vaaQueue: Queue<JobData, string[], string>;
    private worker;
    private prefix;
    constructor(relayer: RelayerApp<T>, storageOptions: StorageOptions);
    addVaaToQueue(vaaBytes: Buffer): Promise<Job<JobData, string[], string>>;
    private vaaId;
    startWorker(): void;
}
