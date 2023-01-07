import { Counter, Gauge, Histogram } from "prom-client";

export const inProgressWorkflowsGauge = new Gauge({
  name: "in_progress_workflows",
  help: "Gauge for number of workflows that are currently being executed",
  labelNames: [],
});

export const maxActiveWorkflowsGauge = new Gauge({
  name: "max_active_workflows",
  help: "Gauge for maximun number of workflows allowed to be executed concurrently",
  labelNames: [],
});

export const executedWorkflows = new Counter({
  name: "executed_workflows_total",
  help: "Counter for number of workflows that were executed",
  labelNames: ["plugin"],
});

export const completedWorkflows = new Counter({
  name: "completed_workflows_total",
  help: "Counter for number of workflows that were executed",
  labelNames: ["plugin"],
});

export const failedWorkflows = new Counter({
  name: "failed_workflows_total",
  help: "Counter for number of workflows that were executed",
  labelNames: ["plugin"],
});

export const inQueueTimeSeconds = new Histogram({
  name: "workflow_queue_duration_seconds",
  help: "Number of seconds spent in queue before being picked up by an executor",
});

export const executingTimeSeconds = new Histogram({
  name: "workflow_execution_duration_seconds",
  help: "Number of seconds spent executing by an executor",
  labelNames: ["plugin"],
});
