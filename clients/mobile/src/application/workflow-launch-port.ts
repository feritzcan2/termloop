import type { SessionDto, TaskPreviewWorkflowParams, WorkflowConfigurationDto } from "@termloop/contract/current";

export interface WorkflowLaunchPort {
  start(connectionId: string, params: TaskPreviewWorkflowParams, configuration: WorkflowConfigurationDto): Promise<SessionDto>;
}

export class WorkflowLaunchUnconfirmedError extends Error {
  constructor() {
    super("The Mac did not confirm the launch. It may already be running. Refresh this Task and check its agents before starting again.");
    this.name = "WorkflowLaunchUnconfirmedError";
  }
}
