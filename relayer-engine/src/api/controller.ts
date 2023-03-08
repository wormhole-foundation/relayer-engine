import { Storage } from "../storage";
import { Context } from "koa";

class WorkflowsController {
  constructor(private storage: Storage) {}

  getWorkflow = async (ctx: Context) => {
    const { pluginName, id } = ctx.query;
    if (
      typeof pluginName !== "string" ||
      typeof id !== "string" ||
      pluginName === "" ||
      id === ""
    ) {
      // TODO implement error handling and better api error codes
      ctx.body = "Invalid plugin name or id provided in query parameters";
      ctx.status = 400;
      return;
    }
    const res = await this.storage.getWorkflow({ pluginName, id });
    if (!res) {
      ctx.status = 404;
      return;
    }
    ctx.body = res.workflow;
  };

  getWorkflowsByStatus = async (ctx: Context) => {
    const status = ctx.params.status.toLowerCase();
    let workflows;
    switch (status) {
      case "ready":
        workflows = await this.storage.getReadyWorkflows(0, -1);
        break;
      case "failed":
        workflows = await this.storage.getFailedWorkflows(0, -1);
        break;
      case "inprogress":
        workflows = await this.storage.getInProgressWorkflows(0, -1);
        break;
      case "reattempting":
        workflows = await this.storage.getDelayedWorkflows(0, -1);
        break;
      case "completed":
        workflows = await this.storage.getCompletedWorkflows(0, -1);
        break;
      default:
        ctx.status = 400;
        ctx.body =
          "Wrong status, allowed values are: reattempting, ready, failed, inprogress, completed";
        return;
    }
    ctx.body = workflows;
  };

  moveFailedWorkflowToReady = async (ctx: Context) => {
    const { pluginName, id } = ctx.request.body as any;
    const workflow = await this.storage.moveFailedWorkflowToReady({
      id,
      pluginName,
    });
    ctx.body = workflow;
  };
}

export { WorkflowsController };
