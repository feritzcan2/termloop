import type { Session, Task, WorkflowExecution } from "../model.js";
import { isLiveSession } from "../model.js";
import { workflowStepSessionId } from "./workflow-presentation.js";

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
    const task = tasksById.get(execution.taskId);
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
      const context = [taskTitle, execution.workflowName, stepLabel,
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
