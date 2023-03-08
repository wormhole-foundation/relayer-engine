const CONSTANTS = {
  READY_WORKFLOW_QUEUE: "__workflowQ", // workflows ready to execute
  ACTIVE_WORKFLOWS_QUEUE: "__activeWorkflows",
  COMPLETED_WORKFLOWS_QUEUE: "__completedWorkflows",
  DEAD_LETTER_QUEUE: "__deadWorkflows",
  DELAYED_WORKFLOWS_QUEUE: "__delayedWorkflows", // failed workflows being delayed before going back to ready to execute
  EXECUTORS_HEARTBEAT_HASH: "__executorsHeartbeats",
  STAGING_AREA_KEY: "__stagingArea",
  CHECK_REQUEUED_WORKFLOWS_LOCK: "__isRequeueJobRunning",
  CHECK_STALE_ACTIVE_WORKFLOWS_LOCK: "_isStaleWorkflowsJobRunning",
  EMITTER_KEY: "__emitter",
};

/**
 * Returns a namespaced set of constants.
 *
 * @param namespace namespace to append to a constant name declared above, if it is not present
 *                  the result is going to be a copy of the current constant object.
 * @returns a new object with all the namespaced constants or a copy of it if non namespace was provided
 */
export const constantsWithNamespace = (
  namespace: string,
): Record<string, string> =>
  Object.entries(CONSTANTS)
    .map(([key, value]) => ({ [key]: [namespace, value].join("") }))
    .reduce((acc, item) => ({ ...acc, ...item }), {});
