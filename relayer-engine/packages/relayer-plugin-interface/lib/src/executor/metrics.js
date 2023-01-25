"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executingTimeSeconds = exports.inQueueTimeSeconds = exports.failedWorkflows = exports.completedWorkflows = exports.executedWorkflows = exports.maxActiveWorkflowsGauge = exports.inProgressWorkflowsGauge = void 0;
const prom_client_1 = require("prom-client");
exports.inProgressWorkflowsGauge = new prom_client_1.Gauge({
    name: "in_progress_workflows",
    help: "Gauge for number of workflows that are currently being executed",
    labelNames: [],
});
exports.maxActiveWorkflowsGauge = new prom_client_1.Gauge({
    name: "max_active_workflows",
    help: "Gauge for maximun number of workflows allowed to be executed concurrently",
    labelNames: [],
});
exports.executedWorkflows = new prom_client_1.Counter({
    name: "executed_workflows_total",
    help: "Counter for number of workflows that were executed",
    labelNames: ["plugin"],
});
exports.completedWorkflows = new prom_client_1.Counter({
    name: "completed_workflows_total",
    help: "Counter for number of workflows that were executed",
    labelNames: ["plugin"],
});
exports.failedWorkflows = new prom_client_1.Counter({
    name: "failed_workflows_total",
    help: "Counter for number of workflows that were executed",
    labelNames: ["plugin"],
});
exports.inQueueTimeSeconds = new prom_client_1.Histogram({
    name: "workflow_queue_duration_seconds",
    help: "Number of seconds spent in queue before being picked up by an executor",
});
exports.executingTimeSeconds = new prom_client_1.Histogram({
    name: "workflow_execution_duration_seconds",
    help: "Number of seconds spent executing by an executor",
    labelNames: ["plugin"],
});
//# sourceMappingURL=metrics.js.map