import { Counter } from "prom-client";

export const receivedEventsCounter = new Counter({
  name: "received_events_total",
  help: "Counter for number of events received by the listener",
  labelNames: ["plugin"],
});

export const erroredEventsCounter = new Counter({
  name: "errored_events_total",
  help: "Counter for number of events that failed to be consumed (or add the workflow)",
  labelNames: ["plugin"],
});

export const createdWorkflowsCounter = new Counter({
  name: "created_workflows_total",
  help: "Counter for number of created workflows by the listener",
  labelNames: ["plugin"],
});
