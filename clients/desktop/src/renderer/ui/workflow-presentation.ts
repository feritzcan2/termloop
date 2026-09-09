import type { AgentLibraryEntry, AssistantPermission, WorkflowConfigurationDto, WorkflowStepDto, WorkflowStepKind, WorkflowStepResultDto } from "@termloop/contract/current";
import type { WorkflowExecution } from "../model.js";

export type WorkflowReasoning = NonNullable<WorkflowStepDto["reasoning"]>;

export type WorkflowLaunchSelection = {
  model: string;
  permission: AssistantPermission;
  reasoning: WorkflowReasoning;
};

export function isHelperStep(step: WorkflowStepDto): boolean {
  return step.kind === "discuss" || step.kind === "review";
}

export function nextStepId(kind: WorkflowStepKind, steps: readonly Pick<WorkflowStepDto, "id">[]): string {
  const ids = new Set(steps.map((step) => step.id));
  for (let index = 1; index <= 8; index += 1) {
    const candidate = `${kind}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${kind}-step`;
}

export function stepKindLabel(kind: WorkflowStepKind): string {
  if (kind === "discuss") return "Discuss";
  if (kind === "review") return "Review";
  if (kind === "fix") return "Fix";
  return "Implement";
}

export function agentLabel(agentId: string | null): string {
  if (agentId === "claude") return "Claude";
  if (agentId === "codex") return "Codex";
  return agentId ?? "Agent";
}

export function stepOwnerSummary(
  step: WorkflowStepDto,
  steps: readonly WorkflowStepDto[],
  agentProfiles: readonly AgentLibraryEntry[],
): string {
  if (!isHelperStep(step)) return "Uses workflow lead";
  if (!step.reuseStepId) return `${workflowAgentProfileLabel(step, agentProfiles)} · new conversation`;
  const source = steps.find((candidate) => candidate.id === step.reuseStepId);
  return `${workflowAgentProfileLabel(source ?? step, agentProfiles)} · continues “${source?.title ?? step.reuseStepId}”`;
}

export function workflowLaunchSummary(selection: WorkflowLaunchSelection): string {
  return `${workflowModelLabel(selection.model)} · ${workflowPermissionLabel(selection.permission)} · ${workflowReasoningLabel(selection.reasoning)}`;
}

export function workflowModelLabel(model: string): string {
  return model === "default" ? "Default model" : model;
}

export function workflowPermissionLabel(permission: AssistantPermission): string {
  if (permission === "bypassPermissions") return "Bypass permissions";
  if (permission === "acceptEdits") return "Auto edits";
  if (permission === "plan") return "Plan only";
  return "Provider default";
}

export function workflowReasoningLabel(reasoning: WorkflowReasoning): string {
  return reasoning === "default" ? "Default thinking" : `${reasoning[0]?.toUpperCase()}${reasoning.slice(1)}`;
}

export function selectionOptions<T extends string>(options: readonly T[], selected: T): readonly T[] {
  return options.includes(selected) ? options : [selected, ...options];
}

export function workflowSummary(configuration: WorkflowConfigurationDto): string {
  const discussions = configuration.steps.filter((step) => step.kind === "discuss").length;
  const reviews = configuration.steps.filter((step) => step.kind === "review").length;
  return [
    discussions ? `${discussions} discussion${discussions === 1 ? "" : "s"} in order` : undefined,
    "Implement",
    reviews ? `${reviews} reviewer${reviews === 1 ? "" : "s"}${reviews > 1 ? " in parallel" : ""}` : undefined,
    configuration.steps.some((step) => step.kind === "fix") ? `Fix findings ↳ review again (up to ${configuration.maxReviewCycles} rounds)` : undefined,
  ].filter(Boolean).join(" → ");
}

export function workflowExecutionSummary(execution: WorkflowExecution): string {
  if (execution.status === "completed") return `${execution.workflowName}: ${workflowStatusLabel(execution)}`;
  const step = execution.steps[execution.currentStepIndex];
  return `${execution.workflowName}: ${step?.title ?? "in progress"} (${execution.currentStepIndex + 1}/${execution.steps.length})`;
}

export function workflowStatusLabel(execution: WorkflowExecution): string {
  if (execution.status === "completed") {
    if (execution.completionOutcome === "approved") return "Approved";
    if (execution.completionOutcome === "reviewLimitReached") return "Review limit reached";
    if (execution.completionOutcome === "changesRequested") return "Changes requested";
    return "Completed";
  }
  if (execution.status === "paused") return "Paused";
  return "Running";
}

export function workflowPhaseLabel(execution: WorkflowExecution, step: WorkflowStepDto | undefined): string {
  if (execution.status === "completed") {
    if (execution.completionOutcome === "approved") return "All reviewers approved the final result";
    if (execution.completionOutcome === "reviewLimitReached") return "Review limit reached — the last fixes have not been reviewed again";
    if (execution.completionOutcome === "changesRequested") return "Reviewers requested changes — no automatic fix step was configured";
    return "Workflow completed; no final review approval was recorded";
  }
  if (execution.status === "paused") return "Lead agent stopped — open its conversation to resume, or stop the workflow";
  const reviewCount = step?.kind === "review" ? activeReviewIndexes(execution).length : 0;
  if (execution.phase === "awaitingHelper" && reviewCount) return `Waiting for ${execution.pendingReviewStepIds.length} of ${reviewCount} reviewer${reviewCount === 1 ? "" : "s"}`;
  if (execution.phase === "awaitingHelper") return `Waiting for ${agentLabel(step?.agentId ?? null)}`;
  if (execution.phase === "awaitingStepCompletion" && reviewCount) return `All ${reviewCount} review replies delivered — coordinator is recording outcomes`;
  if (execution.phase === "awaitingStepCompletion") return "Helper reply delivered — coordinator is deciding the outcome";
  if (step?.kind === "implement") return "Coordinator is implementing the agreed approach";
  if (step?.kind === "fix") return "Coordinator is applying the combined review findings";
  return "Coordinator is starting this step";
}

export function workflowStepParticipant(
  step: WorkflowStepDto,
  steps: readonly WorkflowStepDto[],
  agentProfiles: readonly AgentLibraryEntry[],
): string {
  if (!isHelperStep(step)) return "Lead agent";
  if (!step.reuseStepId) return `${workflowAgentProfileLabel(step, agentProfiles)} · new conversation`;
  const source = steps.find((candidate) => candidate.id === step.reuseStepId);
  return `${workflowAgentProfileLabel(source ?? step, agentProfiles)} · continues “${source?.title ?? step.reuseStepId}”`;
}

export function workflowAgentProfileLabel(
  step: WorkflowStepDto,
  agentProfiles: readonly AgentLibraryEntry[],
): string {
  return agentProfiles.find((profile) => profile.id === step.profileRef)?.name ?? agentLabel(step.agentId);
}

export function workflowStepResult(execution: WorkflowExecution, stepId: string): WorkflowStepResultDto | undefined {
  return execution.stepResults.find((result) => result.stepId === stepId);
}

export function workflowStepState(
  execution: WorkflowExecution,
  index: number,
  result: WorkflowStepResultDto | undefined,
): "complete" | "current" | "upcoming" | "skipped" {
  if (execution.status === "completed") return result?.outcome === "skipped" ? "skipped" : "complete";
  if (activeReviewIndexes(execution).includes(index)) {
    return result?.reviewCycle === execution.reviewCycle ? "complete" : "current";
  }
  if (index === execution.currentStepIndex) return "current";
  if (index < execution.currentStepIndex) return result?.outcome === "skipped" ? "skipped" : "complete";
  return "upcoming";
}

export function activeReviewIndexes(execution: WorkflowExecution): number[] {
  if (execution.steps[execution.currentStepIndex]?.kind !== "review") return [];
  const indexes: number[] = [];
  for (let index = execution.currentStepIndex; index < execution.steps.length; index += 1) {
    if (execution.steps[index]?.kind !== "review") break;
    indexes.push(index);
  }
  return indexes;
}

export function workflowStepSessionId(execution: WorkflowExecution, step: WorkflowStepDto): string | undefined {
  if (!isHelperStep(step)) return execution.coordinatorSessionId;
  const participant = execution.participants.find((candidate) => candidate.stepId === step.id)
    ?? (step.reuseStepId
      ? execution.participants.find((candidate) => candidate.stepId === step.reuseStepId)
      : undefined);
  return participant?.sessionId;
}

export function workflowStepResultLabel(
  kind: WorkflowStepKind,
  outcome: WorkflowStepResultDto["outcome"],
): string {
  if (outcome === "approved") return "Approved";
  if (outcome === "changesRequested") return "Changes requested";
  if (outcome === "skipped") return "Skipped";
  if (kind === "discuss") return "Decision";
  if (kind === "fix") return "Fixed";
  return "Completed";
}

export function workflowStepResultFileName(
  step: WorkflowStepDto,
  steps: readonly WorkflowStepDto[],
): string {
  if (step.kind === "discuss") return "decisions.md";
  if (step.kind === "implement") return "implementation.md";
  if (step.kind === "fix") return "fixes.md";
  const reviews = steps.filter((candidate) => candidate.kind === "review");
  if (reviews.length === 1) return "review.md";
  const suffix = step.id
    .toLowerCase()
    .replace(/^review-?/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return `review-${suffix || reviews.indexOf(step) + 1}.md`;
}
