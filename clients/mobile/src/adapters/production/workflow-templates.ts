import { WorkflowMutationUnconfirmedError, type WorkflowTemplatesPort } from "../../application/workflow-templates-port";
import { MobileControlError, type MobileControlClient } from "./mobile-control-client";

async function confirmedMutation<T>(command: () => Promise<T>): Promise<T> {
  try { return await command(); }
  catch (cause) {
    // A structured daemon rejection is definitive. A lost or malformed reply
    // is not: repeating a create could produce two templates.
    if (cause instanceof MobileControlError && cause.code !== undefined
      && ["conflict", "invalidMessage", "notFound", "unauthenticated", "capabilityDenied", "methodNotFound", "unsupportedMobileApi", "unsupportedVersion", "requestTooLarge", "serviceBusy", "agentUnsupported", "capabilityUnproven", "quotaExceeded"].includes(cause.code)) throw cause;
    throw new WorkflowMutationUnconfirmedError();
  }
}

export function createWorkflowTemplatesPort(
  resolve: (connectionId: string) => Promise<Pick<MobileControlClient, "call">>,
): WorkflowTemplatesPort {
  return {
    async list(connectionId, projectId) {
      return (await resolve(connectionId)).call("workflow.configurationList", { projectId });
    },
    async catalog(connectionId) {
      const control = await resolve(connectionId);
      const [capabilities, library] = await Promise.all([
        control.call("agent.capabilityList"), control.call("agent.libraryGet"),
      ]);
      return { capabilities, profiles: library.profiles };
    },
    async create(connectionId, params) {
      const control = await resolve(connectionId);
      return confirmedMutation(() => control.call("workflow.configurationCreate", { ...params }));
    },
    async update(connectionId, params) {
      const control = await resolve(connectionId);
      return confirmedMutation(() => control.call("workflow.configurationUpdate", { ...params }));
    },
    async remove(connectionId, params) {
      const control = await resolve(connectionId);
      return confirmedMutation(() => control.call("workflow.configurationDelete", { ...params }));
    },
  };
}
