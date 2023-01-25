import { Plugin, StagingAreaKeyLock, Workflow, WorkflowId } from "relayer-plugin-interface";
import { RedisCommandRawReply } from "@node-redis/client/dist/lib/commands";
export { InMemory } from "./inMemoryStore";
export { createStorage } from "./storage";
export declare enum StoreType {
    InMemory = "InMemory",
    Redis = "Redis"
}
export declare type WorkflowWithPlugin = {
    plugin: Plugin;
    workflow: Workflow;
};
export interface Storage {
    getNextWorkflow(timeoutInSeconds: number): Promise<null | WorkflowWithPlugin>;
    requeueWorkflow(workflow: Workflow, reExecuteAt: Date): Promise<void>;
    handleStorageStartupConfig(plugins: Plugin[]): Promise<void>;
    numActiveWorkflows(): Promise<number>;
    numEnqueuedWorkflows(): Promise<number>;
    numDelayedWorkflows(): Promise<number>;
    completeWorkflow(workflow: {
        id: WorkflowId;
        pluginName: string;
    }): Promise<void>;
    addWorkflow(workflow: Workflow): Promise<void>;
    getStagingAreaKeyLock(pluginName: string): StagingAreaKeyLock;
    moveWorkflowsToReadyQueue(): Promise<number>;
}
export declare enum Direction {
    LEFT = "LEFT",
    RIGHT = "RIGHT"
}
declare type Opts = {
    NX: true | undefined;
    PX: number;
};
export interface IRedis {
    multi(): Multi;
    watch(key: string | string[]): Promise<string>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<number>;
    set(key: string, value: string, options?: Opts): Promise<string | null>;
    unwatch(): Promise<string>;
    hLen(key: string): Promise<number>;
    hSet(key: string, field: string, val: string): Promise<number>;
    hGet(key: string, field: string): Promise<string | undefined>;
    rPop(key: string): Promise<string | null>;
    lPush(key: string, val: string | string[]): Promise<number>;
    lLen(key: string): Promise<number>;
    lIndex(key: string, ix: number): Promise<string | null>;
    blMove(source: string, destination: string, sourceDirection: Direction, destinationDirection: Direction, timeout: number): Promise<string | null>;
    lRem(key: string, count: number, element: string): Promise<number>;
    hDel(key: string, field: string): Promise<number>;
    hKeys(key: string): Promise<string[]>;
    zRangeWithScores(key: string, start: number, end: number): Promise<{
        value: string;
        score: number;
    }[]>;
    zAdd(key: string, elements: {
        value: string;
        score: number;
    }[]): Promise<number>;
    executeIsolated<T>(fn: (redis: IRedis) => Promise<T>): Promise<T>;
}
export interface Multi {
    hDel(key: string, field: string): Multi;
    del(key: string): Multi;
    lPush(key: string, element: string | string[]): Multi;
    zAdd(key: string, elements: {
        value: string;
        score: number;
    }[]): Multi;
    lRem(key: string, count: number, element: string): Multi;
    zRem(key: string, element: string | string[]): Multi;
    set(key: string, value: string): Multi;
    hSet(key: string, field: string, val: string): Multi;
    hGet(key: string, field: string): Multi;
    exec(pipeline?: boolean): Promise<RedisCommandRawReply[]>;
}
export declare type WriteOp = (redis: IRedis) => Promise<void>;
export declare type Op<T> = (redis: IRedis) => Promise<T>;
export interface RedisWrapper {
    runOpWithRetry(op: WriteOp): Promise<void>;
    withRedis<T>(op: Op<T>): Promise<T>;
}
