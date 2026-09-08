import type { WorkflowConfigurationCreateParams, WorkflowConfigurationListResult } from "@termloop/contract/current";
import type { WorkflowTemplatesPort } from "./workflow-templates-port";

interface WorkflowTemplateTarget {
  connectionId: string;
  projectId: string;
  existing?: { id: string; generation: number };
}

// Generation protects the draft the user actually edited. The fresh global
// revision then closes the race between this read and the daemon mutation.
async function readForMutation(port: WorkflowTemplatesPort, target: WorkflowTemplateTarget, publish: (snapshot: WorkflowConfigurationListResult) => void) {
  const snapshot = await port.list(target.connectionId, target.projectId);
  publish(snapshot);
  if (target.existing) {
    const saved = snapshot.configurations.find((item) => item.id === target.existing!.id && item.projectId === target.projectId);
    if (!saved) throw new Error("This template was deleted on your Mac. Your draft has not been saved.");
    if (saved.generation !== target.existing.generation) throw new Error("This template changed on your Mac. Load the saved version before editing it again.");
  }
  return snapshot;
}

export async function saveWorkflowTemplate(
  port: WorkflowTemplatesPort,
  target: WorkflowTemplateTarget,
  draft: Omit<WorkflowConfigurationCreateParams, "projectId" | "expectedRevision">,
  publish: (snapshot: WorkflowConfigurationListResult) => void,
) {
  const snapshot = await readForMutation(port, target, publish);
  if (!target.existing && snapshot.configurations.length >= 16) throw new Error("This project has 16 templates. Delete one before creating another.");
  const result = target.existing
    ? await port.update(target.connectionId, { ...draft, workflowId: target.existing.id, expectedRevision: snapshot.stateRevision })
    : await port.create(target.connectionId, { ...draft, projectId: target.projectId, expectedRevision: snapshot.stateRevision });
  publish({ ...snapshot, stateRevision: result.stateRevision, configurations: [...snapshot.configurations.filter((item) => item.id !== result.configuration.id), result.configuration] });
}

export async function deleteWorkflowTemplate(
  port: WorkflowTemplatesPort,
  target: WorkflowTemplateTarget & { existing: { id: string; generation: number } },
  publish: (snapshot: WorkflowConfigurationListResult) => void,
) {
  const snapshot = await readForMutation(port, target, publish);
  const result = await port.remove(target.connectionId, { workflowId: target.existing.id, expectedRevision: snapshot.stateRevision });
  publish({ ...snapshot, stateRevision: result.stateRevision, configurations: snapshot.configurations.filter((item) => item.id !== result.workflowId) });
}
