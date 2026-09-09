import type { SessionDto, TaskDto, WorkflowExecutionDto } from "@termloop/contract/current";
import type { AgentRow } from "./attention-overview";
import { agentName, sessionLabel } from "./dto-readers";
import type { RowTone } from "./tone";
import { workflowExecutionView } from "./workflow-execution";

export interface WorkflowAgentGroup {
  executionId: string;
  name: string;
  taskTitle: string | undefined;
  status: string;
  tone: RowTone;
}

export interface WorkflowAgentMembership {
  group: WorkflowAgentGroup;
  displayName: string;
}

/** Display-only identity from exact execution membership, never names or paths. */
export function workflowAgentMemberships(
  executions: readonly WorkflowExecutionDto[],
  sessions: readonly SessionDto[],
  tasks: readonly TaskDto[],
  projectId: string,
): ReadonlyMap<string, WorkflowAgentMembership> {
  const memberships = new Map<string, WorkflowAgentMembership>();
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const execution of [...executions].sort((a, b) => a.updatedAtEpochMs - b.updatedAtEpochMs)) {
    if (execution.projectId !== projectId) continue;
    const task = tasksById.get(execution.taskId);
    const view = workflowExecutionView(execution, [], []);
    const group: WorkflowAgentGroup = {
      executionId: execution.id, name: execution.workflowName,
      taskTitle: task?.project_id === projectId ? task.title : undefined,
      status: view.label, tone: view.tone,
    };
    const add = (sessionId: string, role: string, coordinator = false) => {
      const session = sessionsById.get(sessionId);
      if (!session || session.kind !== "Agent" || session.project_id !== projectId || session.archived_at_epoch_ms !== null) return;
      const name = coordinator && session.name === execution.workflowName ? agentName(session) : sessionLabel(session);
      memberships.set(sessionId, { group, displayName: `${role} · ${name}` });
    };
    add(execution.coordinatorSessionId, execution.status !== "completed" && execution.steps[execution.currentStepIndex]?.kind === "fix" ? "Fixer" : "Implementer", true);
    // Include exact participants even when an older snapshot lacks their step.
    for (const participant of execution.participants) add(participant.sessionId, "Participant");
    for (const step of execution.steps) {
      if (step.kind !== "discuss" && step.kind !== "review") continue;
      const participant = execution.participants.find((item) => item.stepId === step.id);
      if (participant) add(participant.sessionId, step.kind === "review" ? "Reviewer" : "Advisor");
    }
  }
  return memberships;
}

/** Preserve existing hierarchy/order; unrelated Ask-To helpers break the frame. */
export function workflowAgentSegments(rows: readonly AgentRow[], memberships: ReadonlyMap<string, WorkflowAgentMembership>) {
  const segments: { group: WorkflowAgentGroup | undefined; rows: AgentRow[] }[] = [];
  for (const row of rows) {
    const group = memberships.get(row.sessionId)?.group;
    const previous = segments.at(-1);
    if (previous && previous.group?.executionId === group?.executionId) previous.rows.push(row);
    else segments.push({ group, rows: [row] });
  }
  return segments;
}
