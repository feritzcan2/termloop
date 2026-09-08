import type { WorkflowLaunchPort } from "../../application/workflow-launch-port";
import { WorkflowLaunchUnconfirmedError } from "../../application/workflow-launch-port";
import { MobileControlError, type MobileControlClient } from "./mobile-control-client";

export function createWorkflowLaunchPort(
  resolve: (connectionId: string) => Promise<Pick<MobileControlClient, "call">>,
): WorkflowLaunchPort {
  return {
    async start(connectionId, params, configuration) {
      const goal = params.goal.trim();
      if (!goal || goal.length > 32_768) throw new Error("Enter a workflow goal of up to 32,768 characters.");
      const control = await resolve(connectionId);
      const snapshot = await control.call("workflow.configurationList", { projectId: configuration.projectId });
      const current = snapshot.configurations.find((item) => item.id === params.workflowId && item.projectId === configuration.projectId);
      if (!current || current.id !== configuration.id || current.generation !== configuration.generation) {
        throw new Error("This template changed on the Mac. Refresh the templates and check your selection before starting.");
      }
      if (snapshot.executions.some((item) => item.taskId === params.taskId && item.status !== "completed")) {
        throw new Error("This Task already has an active workflow. Refresh to open its lead agent.");
      }
      const target = { taskId: params.taskId, workflowId: params.workflowId, goal };
      const preview = await control.call("task.previewWorkflow", target);
      try {
        // Spend the ticket once, with exactly the goal and template it inspected.
        // Never replay launch on timeout, reconnect, or a malformed response.
        return await control.call("task.launchWorkflow", { ...target, launchTicket: preview.launch_ticket });
      } catch (cause) {
        if (cause instanceof MobileControlError && cause.code !== undefined
          && ["conflict", "invalidMessage", "notFound", "unauthenticated", "capabilityDenied", "methodNotFound", "unsupportedMobileApi", "unsupportedVersion", "requestTooLarge", "serviceBusy", "agentUnsupported", "capabilityUnproven", "quotaExceeded"].includes(cause.code)) throw cause;
        throw new WorkflowLaunchUnconfirmedError();
      }
    },
  };
}
