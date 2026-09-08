import type { WorkflowConfigurationDto } from "@termloop/contract/current";

export function workflowConfiguration(overrides: Partial<WorkflowConfigurationDto> = {}): WorkflowConfigurationDto {
  return {
    id: "workflow-1", projectId: "project-1", name: "Build and verify",
    coordinatorAgentId: "codex", model: "default", permission: "acceptEdits", reasoning: "default",
    maxReviewCycles: 2, generation: 1, updatedAtEpochMs: 1,
    steps: [{
      id: "implement", kind: "implement", title: "Implement", instructions: "Build and verify.",
      agentId: null, reuseStepId: null, profileRef: null, model: null, permission: null, reasoning: null,
    }],
    ...overrides,
  };
}
