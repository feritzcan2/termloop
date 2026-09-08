import type { AgentStatusDto, SessionDto, WorkflowConfigurationDto, WorkflowExecutionDto } from "@termloop/contract/current";
import { startingWorkflowSteps, workflowDraft } from "../presentation/workflow-template";
import { fixtureSessions, fixtureTasks } from "./mobile-overview";

/** Explicit development/test evidence, never used by the production adapter. */
export function fixtureWorkflowProgress(now = Date.now()) {
  const task = fixtureTasks[0]!;
  const configuration: WorkflowConfigurationDto = { ...workflowDraft(), id: "workflow-demo", projectId: task.project_id, name: "Discuss, build & review", steps: startingWorkflowSteps("discussed"), generation: 1, updatedAtEpochMs: now - 360_000 };
  const [discuss, implement, context, independent, fix] = configuration.steps;
  const execution: WorkflowExecutionDto = {
    id: "workflow-execution-demo", projectId: task.project_id, taskId: task.id, workflowId: configuration.id, workflowGeneration: 1, workflowName: configuration.name,
    goal: task.brief || task.title, coordinatorSessionId: fixtureSessions[0]!.id, currentStepIndex: 2, reviewCycle: 2, maxReviewCycles: 3,
    phase: "awaitingHelper", status: "running", completionOutcome: null, steps: configuration.steps,
    participants: [{ stepId: discuss!.id, sessionId: "workflow-context" }, { stepId: context!.id, sessionId: "workflow-context" }, { stepId: independent!.id, sessionId: "workflow-independent" }],
    activeReviewStepIds: [context!.id, independent!.id], pendingReviewStepIds: [context!.id],
    stepResults: [
      { stepId: discuss!.id, reviewCycle: 1, outcome: "completed", summary: "Agreed approach\n\nKeep workflow progress on the Task screen. Show each agent separately and preserve saved results when the phone reconnects.", completedAtEpochMs: now - 300_000 },
      { stepId: implement!.id, reviewCycle: 1, outcome: "completed", summary: "Added the mobile workflow tracker and focused tests. Progress, review rounds, and agent conversations are now visible from the Task.", completedAtEpochMs: now - 240_000 },
      { stepId: context!.id, reviewCycle: 1, outcome: "changesRequested", summary: "Two findings\n\n1. Keep a previous round’s result visible without counting it as approval for the next round.\n2. Mark cached agent states as last known while the Mac is offline.\n\nVerification\nAdd focused regression tests before requesting another review.", completedAtEpochMs: now - 180_000 },
      { stepId: independent!.id, reviewCycle: 2, outcome: "approved", summary: "Approved the updated implementation. Focused checks passed and the earlier findings are resolved.", completedAtEpochMs: now - 30_000 },
      { stepId: fix!.id, reviewCycle: 1, outcome: "completed", summary: "Separated prior-round outcomes from current progress and added an explicit offline snapshot state.", completedAtEpochMs: now - 90_000 },
    ],
    startedAtEpochMs: now - 360_000, updatedAtEpochMs: now - 10_000,
  };
  const sessions: SessionDto[] = [
    { ...fixtureSessions[0]!, name: "Workflow lead", process: { ...fixtureSessions[0]!.process, agent_id: "codex" } },
    { ...fixtureSessions[0]!, id: "workflow-context", name: "Context review", process: { ...fixtureSessions[0]!.process, agent_id: "claude" } },
    { ...fixtureSessions[0]!, id: "workflow-independent", name: "Independent review", process: { ...fixtureSessions[0]!.process, agent_id: "codex" } },
  ];
  const statuses: AgentStatusDto[] = sessions.map((session, index) => ({ sessionId: session.id, status: index === 1 ? "working" : "idle", source: "hook", observedAtEpochMs: now - 1000 }));
  return { configuration, execution, sessions, statuses };
}
