import type { Session, Task, WorkflowExecution } from "../model.js";
import { agentName, isLiveSession } from "../model.js";
import { workflowStatusLabel, workflowStepSessionId } from "./workflow-presentation.js";

export type ActiveAgentWorkflow = {
  executionId: string;
  stepLabel: string;
  context: string;
};

/// Read the durable execution, not the saved template (which may have changed
/// or been deleted). Only exact projected participants can own a row cue.
export function activeAgentWorkflows(
  executions: readonly WorkflowExecution[],
  sessions: readonly Session[],
  tasks: readonly Task[] = [],
): ReadonlyMap<string, readonly ActiveAgentWorkflow[]> {
  const result = new Map<string, ActiveAgentWorkflow[]>();
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const execution of executions) {
    if (execution.phase === "completed" || execution.status === "completed") continue;
    const current = execution.steps[execution.currentStepIndex];
    if (!current) continue;
    const task = execution.taskId ? tasksById.get(execution.taskId) : undefined;
    const taskTitle = task?.project_id === execution.projectId ? task.title : undefined;
    const assigned = new Set<string>();
    const add = (sessionId: string | undefined, index: number, prefix?: string): boolean => {
      const session = sessionId ? sessionsById.get(sessionId) : undefined;
      const step = execution.steps[index];
      if (!session || !step || session.kind !== "Agent" || session.archived_at_epoch_ms !== null
        || session.project_id !== execution.projectId) return false;
      if (assigned.has(session.id)) return true;
      assigned.add(session.id);
      const stepLabel = `${prefix ? `${prefix} · ` : ""}${index + 1}/${execution.steps.length} ${step.title}`;
      const context = [execution.taskId === null ? "Project checkout" : taskTitle, execution.workflowName, stepLabel,
        execution.reviewCycle > 1 ? `Review cycle ${execution.reviewCycle}` : undefined,
      ].filter(Boolean).join(" · ");
      const entries = result.get(session.id) ?? [];
      entries.push({ executionId: execution.id, stepLabel, context });
      result.set(session.id, entries);
      return true;
    };

    let missingHelper = false;
    if (current.kind === "review") {
      // A review group may still be dispatching while earlier reviewers work.
      // Delivered replies and participants from an earlier cycle are not turns.
      for (const stepId of execution.pendingReviewStepIds) {
        if (!execution.activeReviewStepIds.includes(stepId)) continue;
        const index = execution.steps.findIndex((step) => step.id === stepId && step.kind === "review");
        const sessionId = execution.participants.find((participant) => participant.stepId === stepId)?.sessionId;
        if (!add(sessionId, index)) missingHelper = true;
      }
    } else if (execution.phase === "awaitingHelper" && current.kind === "discuss") {
      missingHelper = !add(workflowStepSessionId(execution, current), execution.currentStepIndex);
    }

    const coordinator = sessionsById.get(execution.coordinatorSessionId);
    if (execution.phase !== "awaitingHelper" || assigned.size === 0 || missingHelper) {
      add(execution.coordinatorSessionId, execution.currentStepIndex, missingHelper ? "Helper unavailable" : undefined);
    } else if (coordinator && !isLiveSession(coordinator)) {
      // Helpers may still be working, but a stopped lead must also be resumed
      // to receive their replies. Don't pretend the workflow is solely waiting
      // on a reviewer when the coordinator itself needs recovery.
      add(coordinator.id, execution.currentStepIndex, "Lead paused");
    }
  }
  return result;
}

export function activeAgentWorkflowAction(session: Session): { label: string; resume: boolean } {
  if (!isLiveSession(session) && session.retryable) {
    return {
      label: session.resume_failure_reason === "providerHistoryDamaged" ? "Fix & resume workflow" : "Resume workflow",
      resume: true,
    };
  }
  return { label: "Open workflow", resume: false };
}

/// Role names are presentation only and never rename the stored Session. A
/// workflow member's stored name is usually its prompt's first line, so the
/// row names the role and the provider instead. Membership is exact, including
/// finished runs. A reused helper shows its most recently assigned role, not
/// every role it has ever held.
export function workflowAgentLabels(
  executions: readonly WorkflowExecution[],
  sessions: readonly Session[],
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  for (const execution of [...executions].sort((left, right) => left.updatedAtEpochMs - right.updatedAtEpochMs)) {
    const label = (sessionId: string, role: string) => {
      const session = sessionsById.get(sessionId);
      if (!session || session.kind !== "Agent" || session.project_id !== execution.projectId
        || session.archived_at_epoch_ms !== null) return;
      labels.set(sessionId, `${role} · ${agentName(session)}`);
    };
    const currentStep = execution.steps[execution.currentStepIndex];
    label(execution.coordinatorSessionId,
      execution.status !== "completed" && currentStep?.kind === "fix" ? "Fixer" : "Implementer");
    for (const step of execution.steps) {
      if (step.kind !== "discuss" && step.kind !== "review") continue;
      const participant = execution.participants.find((candidate) => candidate.stepId === step.id);
      if (participant) label(participant.sessionId, step.kind === "review" ? "Reviewer" : "Advisor");
    }
  }
  return labels;
}

export type WorkflowAgentGroup = {
  executionId: string;
  name: string;
  status: WorkflowExecution["status"];
  statusLabel: string;
  needsAttention: boolean;
  context: string;
  /// The current step, e.g. "2/4 Implement"; absent once the run finished.
  stepLabel: string | undefined;
  /// Coordinator first, then each distinct participant in step order.
  memberSessionIds: readonly string[];
  updatedAtEpochMs: number;
};

export type WorkflowAgentRun = {
  workflow: WorkflowAgentGroup;
  sessions: readonly Session[];
};

/// One rail entry per execution that still owns at least one listed Agent. A
/// Session reused by a newer run belongs only to that newer run, exactly as
/// the per-Session group map resolves it.
export function workflowAgentRuns(
  sessions: readonly Session[],
  groups: ReadonlyMap<string, WorkflowAgentGroup> | undefined,
): WorkflowAgentRun[] {
  if (!groups?.size) return [];
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const runs = new Map<string, WorkflowAgentRun>();
  for (const workflow of groups.values()) {
    if (runs.has(workflow.executionId)) continue;
    const members = workflow.memberSessionIds
      .filter((sessionId) => groups.get(sessionId)?.executionId === workflow.executionId)
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is Session => session !== undefined);
    if (members.length) runs.set(workflow.executionId, { workflow, sessions: members });
  }
  return [...runs.values()];
}

/// A visual group is backed by the execution's exact membership, not by its
/// name, worktree or an arbitrary Ask-To helper attached to the same lead.
export function workflowAgentGroups(
  executions: readonly WorkflowExecution[],
  sessions: readonly Session[],
  tasks: readonly Task[] = [],
): ReadonlyMap<string, WorkflowAgentGroup> {
  const groups = new Map<string, WorkflowAgentGroup>();
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const execution of [...executions].sort((left, right) => left.updatedAtEpochMs - right.updatedAtEpochMs)) {
    const task = execution.taskId ? tasksById.get(execution.taskId) : undefined;
    const statusLabel = workflowStatusLabel(execution);
    const currentStep = execution.steps[execution.currentStepIndex];
    const memberSessionIds = [...new Set([execution.coordinatorSessionId, ...execution.participants.map((participant) => participant.sessionId)])];
    const group: WorkflowAgentGroup = {
      executionId: execution.id,
      name: execution.workflowName,
      status: execution.status,
      statusLabel,
      needsAttention: execution.status === "completed"
        && (execution.completionOutcome === "changesRequested" || execution.completionOutcome === "reviewLimitReached"),
      context: [execution.taskId === null ? "Project checkout" : task?.project_id === execution.projectId ? task.title : undefined, execution.workflowName, statusLabel].filter(Boolean).join(" · "),
      stepLabel: execution.status !== "completed" && currentStep
        ? `${execution.currentStepIndex + 1}/${execution.steps.length} ${currentStep.title}` : undefined,
      memberSessionIds,
      updatedAtEpochMs: execution.updatedAtEpochMs,
    };
    for (const sessionId of memberSessionIds) {
      const session = sessionsById.get(sessionId);
      if (session?.kind === "Agent" && session.archived_at_epoch_ms === null && session.project_id === execution.projectId) groups.set(sessionId, group);
    }
  }
  return groups;
}
