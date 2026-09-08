import type { AgentStatusDto, SessionDto, WorkflowExecutionDto, WorkflowStepDto, WorkflowStepResultDto } from "@termloop/contract/current";
import { agentName, sessionLabel } from "./dto-readers";
import { sessionState } from "./session-presentation";
import type { RowTone } from "./tone";
import { workflowAgentName, workflowHelper } from "./workflow-template";

export interface WorkflowAgentView {
  id: string;
  name: string;
  provider: string;
  status: string;
  tone: RowTone;
  available: boolean;
  needsAttention: boolean;
}
export interface WorkflowStepView {
  step: WorkflowStepDto;
  index: number;
  state: "current" | "recording" | "complete" | "skipped" | "upcoming" | "unrecorded";
  label: string;
  tone: RowTone;
  detail: string;
  owner: string;
  agent: WorkflowAgentView | undefined;
  result: WorkflowStepResultDto | undefined;
  previousRound: boolean;
}

export function taskWorkflowExecution(executions: readonly WorkflowExecutionDto[], taskId: string): WorkflowExecutionDto | undefined {
  return executions.filter((item) => item.taskId === taskId).sort((a, b) =>
    Number(a.status === "completed") - Number(b.status === "completed") || b.startedAtEpochMs - a.startedAtEpochMs || b.updatedAtEpochMs - a.updatedAtEpochMs || a.id.localeCompare(b.id),
  )[0];
}

export function workflowResultLabel(outcome: WorkflowStepResultDto["outcome"]): string {
  return { completed: "Completed", approved: "Approved", changesRequested: "Changes requested", skipped: "Skipped" }[outcome];
}

export function workflowExecutionView(execution: WorkflowExecutionDto, sessions: readonly SessionDto[], statuses: readonly AgentStatusDto[]) {
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  const byStatus = new Map(statuses.map((status) => [status.sessionId, status]));
  const readAgent = (id: string, fallback: string): WorkflowAgentView => {
    const session = bySession.get(id);
    if (!session) return { id, name: fallback, provider: fallback, status: "Session unavailable", tone: "quiet", available: false, needsAttention: false };
    // Ordinary-agent "ready for review" heuristics do not establish a workflow
    // result. Only recorded step outcomes may mark a workflow step as complete.
    const state = sessionState(session, byStatus.get(id), false);
    return { id, name: sessionLabel(session), provider: agentName(session), status: state.label ?? (state.id === "idle" ? "Idle" : "Status unavailable"), tone: state.tone, available: true,
      needsAttention: ["awaitingInput", "retryable", "resumeFailed", "stale", "processExited", "failed", "interrupted", "agentExited"].includes(state.id) };
  };
  const lead = readAgent(execution.coordinatorSessionId, "Lead agent");
  const current = execution.steps[execution.currentStepIndex];
  const reviewing = execution.status !== "completed" && current?.kind === "review";
  const reviewSteps = reviewing ? execution.steps.filter((step) => step.kind === "review") : [];
  const pendingReviews = new Set(execution.pendingReviewStepIds);
  const activeReviews = new Set(execution.activeReviewStepIds);
  const rows: WorkflowStepView[] = execution.steps.map((step, index) => {
    const result = execution.stepResults.filter((item) => item.stepId === step.id).sort((a, b) => b.reviewCycle - a.reviewCycle || b.completedAtEpochMs - a.completedAtEpochMs)[0];
    const previousRound = !!result && (step.kind === "review" || step.kind === "fix") && result.reviewCycle < execution.reviewCycle;
    const relevantResult = previousRound ? undefined : result;
    const isCurrent = execution.status !== "completed" && (index === execution.currentStepIndex || (reviewing && step.kind === "review"));
    const participant = execution.participants.find((item) => item.stepId === step.id)
      ?? (step.reuseStepId ? execution.participants.find((item) => item.stepId === step.reuseStepId) : undefined);
    const source = execution.steps.find((item) => item.id === step.reuseStepId);
    const owner = !workflowHelper(step) ? `${lead.provider} · lead agent`
      : step.reuseStepId ? `${workflowAgentName(step.agentId)} · continues “${source?.title ?? "earlier discussion"}”`
      : `${workflowAgentName(step.agentId)} · separate conversation`;
    const agent = workflowHelper(step) ? (participant ? readAgent(participant.sessionId, workflowAgentName(step.agentId)) : undefined) : lead;
    let state: WorkflowStepView["state"] = "upcoming", label = step.kind === "fix" ? "If needed" : "Up next", tone: RowTone = "quiet";
    let detail = step.kind === "fix" ? "Runs only when reviewers request changes." : "Waiting for the earlier steps.";
    if (isCurrent && !relevantResult) {
      const delivered = execution.phase === "awaitingStepCompletion" || (step.kind === "review" && activeReviews.has(step.id) && !pendingReviews.has(step.id));
      state = delivered ? "recording" : "current";
      label = execution.status === "paused" ? "Paused" : delivered ? "Reply received" : "In progress";
      tone = execution.status === "paused" ? "blocked" : "working";
      detail = delivered ? "Waiting for the lead to record the outcome."
        : execution.phase === "awaitingHelper" ? "Waiting for this agent’s reply."
        : step.kind === "implement" ? "The lead is implementing the agreed approach."
        : step.kind === "fix" ? "The lead is applying the combined review findings."
        : "The lead is preparing this conversation.";
    } else if (relevantResult && (execution.status === "completed" || isCurrent || index < execution.currentStepIndex)) {
      state = relevantResult.outcome === "skipped" ? "skipped" : "complete";
      label = workflowResultLabel(relevantResult.outcome);
      tone = relevantResult.outcome === "changesRequested" ? "attention" : "done";
      detail = relevantResult.outcome === "skipped" ? "This step was not needed." : "The lead recorded this outcome.";
    } else if (execution.status === "completed" || index < execution.currentStepIndex) {
      state = "unrecorded"; label = "No result recorded"; detail = "No saved outcome is available for this step.";
    }
    return { step, index, state, label, tone, detail, owner, agent, result, previousRound };
  });
  let label = "Running", tone: RowTone = "working", headline = current?.title ?? "Workflow in progress";
  let detail = "The lead is preparing the next step.";
  const completed = execution.status === "completed";
  if (completed) {
    const outcome = execution.completionOutcome;
    label = outcome === "approved" ? "Approved" : outcome === "changesRequested" ? "Changes requested" : outcome === "reviewLimitReached" ? "Review limit reached" : "Completed";
    tone = outcome === "changesRequested" || outcome === "reviewLimitReached" ? "attention" : "done";
    headline = label;
    detail = outcome === "approved" ? "All reviewers approved the final result."
      : outcome === "changesRequested" ? "Reviewers requested changes. This workflow has no automatic fix step."
      : outcome === "reviewLimitReached" ? "The final fixes have not been reviewed again. Check the results before accepting the work."
      : "The workflow finished. No final review approval was recorded.";
  } else if (execution.status === "paused") {
    label = "Paused"; tone = "blocked"; headline = "The lead agent is not running";
    detail = "Open the lead conversation to check recovery options. Completed results are kept below.";
  } else if (reviewing) {
    headline = reviewSteps.length > 1 ? "Parallel review" : current?.title ?? "Review";
    const delivered = reviewSteps.filter((step) => activeReviews.has(step.id) && !pendingReviews.has(step.id)).length;
    detail = execution.phase === "awaitingCoordinator" ? `The lead is preparing ${reviewSteps.length} reviewer${reviewSteps.length === 1 ? "" : "s"}.`
      : execution.phase === "awaitingHelper" ? `${delivered} of ${reviewSteps.length} replies received. Reviews run in parallel.`
      : "Review replies received. The lead is recording each reviewer’s outcome.";
  } else {
    detail = rows.find((row) => row.state === "current" || row.state === "recording")?.detail ?? detail;
  }
  const waitingHelpers = execution.phase === "awaitingHelper" ? rows.filter((row) => row.state === "current" && workflowHelper(row.step)).flatMap((row) => row.agent ? [row.agent] : []) : [];
  const currentAgents = completed ? [] : [...new Map((waitingHelpers.length ? waitingHelpers : [lead]).map((agent) => [agent.id, agent])).values()];
  const attentionAgents = completed ? [] : [...new Map([lead, ...waitingHelpers].filter((agent) => agent.needsAttention).map((agent) => [agent.id, agent])).values()];
  const done = rows.filter((row) => row.state === "complete" || row.state === "skipped").length;
  const progress = completed ? `${done} of ${rows.length} outcomes recorded` : reviewing ? `${rows.filter((row) => row.step.kind === "review" && row.state === "complete").length}/${reviewSteps.length} reviews recorded` : `Step ${Math.min(execution.currentStepIndex + 1, rows.length)} of ${rows.length}`;
  return { lead, rows, label, tone, headline, detail, currentAgents, attentionAgents, done, progress, completed, reviewing };
}
