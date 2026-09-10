import type { SessionDto, TaskDto, WorkflowExecutionDto } from "@termloop/contract/current";
import { agentClusterMembers, type AgentCluster, type AgentRow } from "./attention-overview";
import { agentName, sessionLabel } from "./dto-readers";
import type { RowTone } from "./tone";
import { workflowExecutionView } from "./workflow-execution";

export interface WorkflowAgentGroup {
  executionId: string;
  name: string;
  taskTitle: string | undefined;
  taskId?: string | undefined;
  jiraUrl?: string | undefined;
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
    const task = execution.taskId ? tasksById.get(execution.taskId) : undefined;
    const view = workflowExecutionView(execution, [], []);
    const group: WorkflowAgentGroup = {
      executionId: execution.id, name: execution.workflowName,
      taskTitle: execution.taskId === null ? "Project checkout" : task?.project_id === projectId ? task.title : undefined,
      taskId: task?.project_id === projectId ? task.id : undefined,
      jiraUrl: task?.project_id === projectId ? task.jira_url ?? undefined : undefined,
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

/** One execution can have several independent roots. Keep its rows together at
 * the first member's urgency position, without absorbing unrelated helpers or
 * crossing a desktop-authored manual group. */
export function workflowAgentClusters(clusters: readonly AgentCluster[], memberships: ReadonlyMap<string, WorkflowAgentMembership>): AgentCluster[] {
  const result: AgentCluster[] = [];
  const indexByExecution = new Map<string, number>();
  for (const cluster of clusters) {
    const members = agentClusterMembers(cluster);
    const executionId = members[0] && memberships.get(members[0].sessionId)?.group.executionId;
    const homogeneous = executionId && cluster.manualGroup === undefined
      && members.every((row) => memberships.get(row.sessionId)?.group.executionId === executionId);
    const index = homogeneous ? indexByExecution.get(executionId) : undefined;
    if (index !== undefined) {
      const previous = result[index]!;
      result[index] = { ...previous, groups: [...previous.groups, ...cluster.groups] };
    } else {
      if (homogeneous) indexByExecution.set(executionId, result.length);
      result.push(cluster);
    }
  }
  return result;
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
