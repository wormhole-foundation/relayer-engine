import { Counter, Gauge, Histogram } from "prom-client";
export declare const inProgressWorkflowsGauge: Gauge<never>;
export declare const maxActiveWorkflowsGauge: Gauge<never>;
export declare const executedWorkflows: Counter<"plugin">;
export declare const completedWorkflows: Counter<"plugin">;
export declare const failedWorkflows: Counter<"plugin">;
export declare const inQueueTimeSeconds: Histogram<string>;
export declare const executingTimeSeconds: Histogram<"plugin">;
