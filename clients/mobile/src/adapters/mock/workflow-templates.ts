import type { WorkflowConfigurationDto } from "@termloop/contract/current";
import type { WorkflowTemplatesPort } from "../../application/workflow-templates-port";
import { fixtureAgentCapabilities } from "../../fixtures/mobile-overview";

// In-memory demo data only. Each mock runtime owns its own isolated catalog.
export function createMockWorkflowTemplates(): WorkflowTemplatesPort {
  const connections = new Map<string, { revision: number; sequence: number; configurations: WorkflowConfigurationDto[] }>();
  const state = (id: string) => {
    let value = connections.get(id);
    if (!value) { value = { revision: 1, sequence: 0, configurations: [] }; connections.set(id, value); }
    return value;
  };
  const copy = (configuration: WorkflowConfigurationDto) => ({ ...configuration, steps: configuration.steps.map((step) => ({ ...step })) });
  const check = (revision: number, expected: number) => { if (revision !== expected) throw new Error("Template state changed. Refresh and try again."); };
  return {
    async list(connectionId, projectId) {
      const current = state(connectionId);
      return { configurations: current.configurations.filter((item) => item.projectId === projectId).map(copy), executions: [], stateRevision: current.revision };
    },
    async catalog() { return { capabilities: fixtureAgentCapabilities, profiles: [] }; },
    async create(connectionId, params) {
      const current = state(connectionId);
      check(current.revision, params.expectedRevision);
      if (current.configurations.filter((item) => item.projectId === params.projectId).length >= 16) throw new Error("A project can have up to 16 templates.");
      const { expectedRevision: _, ...draft } = params;
      const configuration = { ...draft, id: `mock-workflow-${++current.sequence}`, generation: 1, updatedAtEpochMs: Date.now() };
      current.configurations.push(copy(configuration));
      return { configuration: copy(configuration), stateRevision: ++current.revision };
    },
    async update(connectionId, params) {
      const current = state(connectionId);
      check(current.revision, params.expectedRevision);
      const index = current.configurations.findIndex((item) => item.id === params.workflowId);
      const previous = current.configurations[index];
      if (!previous) throw new Error("Template no longer exists.");
      const { workflowId: _, expectedRevision: __, ...draft } = params;
      const configuration = { ...previous, ...draft, generation: previous.generation + 1, updatedAtEpochMs: Date.now() };
      current.configurations[index] = copy(configuration);
      return { configuration: copy(configuration), stateRevision: ++current.revision };
    },
    async remove(connectionId, params) {
      const current = state(connectionId);
      check(current.revision, params.expectedRevision);
      if (!current.configurations.some((item) => item.id === params.workflowId)) throw new Error("Template no longer exists.");
      current.configurations = current.configurations.filter((item) => item.id !== params.workflowId);
      return { workflowId: params.workflowId, deleted: true, stateRevision: ++current.revision };
    },
  };
}
