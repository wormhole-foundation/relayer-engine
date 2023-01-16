import { Plugin, StagingAreaKeyLock, Workflow, WorkflowId } from "relayer-plugin-interface";
import { Logger } from "winston";
import { RedisWrapper, Storage, StoreType, WorkflowWithPlugin } from ".";
import { CommonEnv, WorkflowOptions } from "../config";
export declare function createStorage(plugins: Plugin[], config: CommonEnv, storeType?: StoreType, logger?: Logger): Promise<Storage>;
export declare class DefaultStorage implements Storage {
    private readonly store;
    private readonly plugins;
    private readonly logger;
    private nextReadyWorkflowCheckId?;
    private readonly id;
    private defaultWorkflowOptions;
    constructor(store: RedisWrapper, plugins: Plugin[], defaultWorkflowOptions: WorkflowOptions, logger: Logger);
    numActiveWorkflows(): Promise<number>;
    numEnqueuedWorkflows(): Promise<number>;
    numDelayedWorkflows(): Promise<number>;
    addWorkflow(workflow: Workflow, workflowOptions?: WorkflowOptions): Promise<void>;
    requeueWorkflow(workflow: Workflow, reExecuteAt: Date): Promise<void>;
    completeWorkflow(workflow: {
        id: WorkflowId;
        pluginName: string;
    }): Promise<void>;
    getNextWorkflow(timeoutInSeconds: number): Promise<WorkflowWithPlugin | null>;
    handleStorageStartupConfig(plugins: Plugin[]): Promise<void>;
    getStagingAreaKeyLock(pluginName: string): StagingAreaKeyLock;
    private acquireUnsafeLock;
    private releaseUnsafeLock;
    moveWorkflowsToReadyQueue(): Promise<number>;
}
