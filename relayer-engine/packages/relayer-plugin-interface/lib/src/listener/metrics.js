"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createdWorkflowsCounter = exports.erroredEventsCounter = exports.receivedEventsCounter = void 0;
const prom_client_1 = require("prom-client");
exports.receivedEventsCounter = new prom_client_1.Counter({
    name: "received_events_total",
    help: "Counter for number of events received by the listener",
    labelNames: ["plugin"],
});
exports.erroredEventsCounter = new prom_client_1.Counter({
    name: "errored_events_total",
    help: "Counter for number of events that failed to be consumed (or add the workflow)",
    labelNames: ["plugin"],
});
exports.createdWorkflowsCounter = new prom_client_1.Counter({
    name: "created_workflows_total",
    help: "Counter for number of created workflows by the listener",
    labelNames: ["plugin"],
});
//# sourceMappingURL=metrics.js.map