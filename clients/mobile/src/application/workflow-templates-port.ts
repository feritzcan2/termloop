import type {
  AgentCapabilityDto, AgentLibraryEntry, WorkflowConfigurationCreateParams,
  WorkflowConfigurationDeleteParams, WorkflowConfigurationDeleteResult,
  WorkflowConfigurationListResult, WorkflowConfigurationMutationResult,
  WorkflowConfigurationUpdateParams,
} from "@termloop/contract/current";

export interface WorkflowAgentCatalog {
  capabilities: readonly AgentCapabilityDto[];
  profiles: readonly AgentLibraryEntry[];
}

export class WorkflowMutationUnconfirmedError extends Error {
  constructor() {
    super("The Mac did not confirm this change and may already have applied it. Your draft is kept. Close this editor and refresh the saved templates before trying again.");
    this.name = "WorkflowMutationUnconfirmedError";
  }
}

export interface WorkflowTemplatesPort {
  list(connectionId: string, projectId: string): Promise<WorkflowConfigurationListResult>;
  catalog(connectionId: string): Promise<WorkflowAgentCatalog>;
  create(connectionId: string, params: WorkflowConfigurationCreateParams): Promise<WorkflowConfigurationMutationResult>;
  update(connectionId: string, params: WorkflowConfigurationUpdateParams): Promise<WorkflowConfigurationMutationResult>;
  remove(connectionId: string, params: WorkflowConfigurationDeleteParams): Promise<WorkflowConfigurationDeleteResult>;
}
