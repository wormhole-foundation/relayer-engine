/// <reference types="node" />
import { Job, Queue, Worker } from "bullmq";
import { RelayerApp } from "./application";
import { Context } from "./context";
import { Logger } from "winston";
import { ClusterNode, RedisOptions } from "ioredis";
export interface StorageContext extends Context {
    storage: {
        job: Job;
        worker: Worker;
    };
}
export interface StorageOptions {
    redisCluster?: ClusterNode[];
    redis?: RedisOptions;
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
    private opts;
    logger: Logger;
    vaaQueue: Queue<JobData, string[], string>;
    private worker;
    private prefix;
    private redis;
    constructor(relayer: RelayerApp<T>, opts: StorageOptions);
    addVaaToQueue(vaaBytes: Buffer): Promise<Job<JobData, string[], string>>;
    private vaaId;
    startWorker(): void;
}
