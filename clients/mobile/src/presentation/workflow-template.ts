import type { AgentCapabilityDto, AgentLibraryEntry, StewardAgentId, WorkflowConfigurationCreateParams, WorkflowConfigurationDto, WorkflowStepDto } from "@termloop/contract/current";

export type WorkflowDraft = Omit<WorkflowConfigurationCreateParams, "projectId" | "expectedRevision">;
export type WorkflowStart = "simple" | "reviewed" | "discussed";
export const workflowStarts = [
  { id: "simple", title: "Start simple", detail: "One agent builds and verifies. Add your own steps as you go.", route: "Implement" },
  { id: "reviewed", title: "Build & review", detail: "Build, get an independent review, then fix any findings.", route: "Implement → Review → Fix if needed" },
  { id: "discussed", title: "Discuss, build & review", detail: "Discuss first, then build and get two reviews in parallel.", route: "Discuss → Implement → 2 reviewers → Fix if needed" },
] as const;

export function workflowDraft(configuration?: WorkflowConfigurationDto): WorkflowDraft {
  if (configuration) {
    const { name, coordinatorAgentId, model, permission, reasoning, maxReviewCycles, steps } = configuration;
    return { name, coordinatorAgentId, model, permission, reasoning, maxReviewCycles, steps: steps.map((step) => ({ ...step })) };
  }
  return { name: "", coordinatorAgentId: "codex", model: "default", permission: "bypassPermissions", reasoning: "default", maxReviewCycles: 2, steps: [] };
}

export function workflowHelper(step: WorkflowStepDto): boolean {
  return step.kind === "discuss" || step.kind === "review";
}

export function workflowAgentName(agentId: string | null): string {
  return agentId === "codex" ? "Codex" : agentId === "claude" ? "Claude" : "Lead agent";
}

export function workflowStepLabel(kind: WorkflowStepDto["kind"]): string {
  return ({ discuss: "Discuss", implement: "Implement", review: "Review", fix: "Fix" })[kind];
}

export function workflowPermissionName(permission: WorkflowDraft["permission"]): string {
  return ({ default: "Provider default", acceptEdits: "Auto edits", plan: "Plan only", bypassPermissions: "Bypass permissions" })[permission];
}

export function newWorkflowStep(kind: WorkflowStepDto["kind"], steps: readonly WorkflowStepDto[]): WorkflowStepDto {
  const ids = new Set(steps.map((step) => step.id));
  let suffix = 1;
  while (ids.has(`${kind}-${suffix}`)) suffix += 1;
  const helper = kind === "discuss" || kind === "review";
  return {
    id: `${kind}-${suffix}`, kind, title: kind === "fix" ? "Fix review findings" : workflowStepLabel(kind),
    instructions: ({
      discuss: "Challenge the current approach and surface tradeoffs.",
      implement: "Implement the agreed solution and run proportionate verification.",
      review: "Review the current diff and report concrete, prioritized findings.",
      fix: "Apply the accepted combined findings, rerun verification, and resolve reviewer follow-ups.",
    })[kind],
    agentId: helper ? (kind === "discuss" ? "claude" : "codex") : null,
    reuseStepId: null, profileRef: null, model: helper ? "default" : null,
    permission: helper ? "bypassPermissions" : null, reasoning: helper ? "default" : null,
  };
}

export function startingWorkflowSteps(start: WorkflowStart): WorkflowStepDto[] {
  const implementation = newWorkflowStep("implement", []);
  if (start === "simple") return [implementation];
  const review = { ...newWorkflowStep("review", []), title: "Independent review" };
  const fix = newWorkflowStep("fix", []);
  if (start === "reviewed") return [implementation, review, fix];
  const discussion = { ...newWorkflowStep("discuss", []), title: "Challenge the approach" };
  const contextual: WorkflowStepDto = {
    ...newWorkflowStep("review", [review]), title: "Review with prior context", agentId: "claude",
    reuseStepId: discussion.id, model: null, permission: null, reasoning: null,
  };
  return [discussion, implementation, contextual, { ...review, title: "Independent second review" }, fix];
}

export function addWorkflowStep(steps: readonly WorkflowStepDto[], kind: "discuss" | "review" | "fix"): WorkflowStepDto[] {
  if (steps.length >= 8 || (kind === "fix" && (!steps.some((step) => step.kind === "review") || steps.some((step) => step.kind === "fix")))) return [...steps];
  const next = [...steps];
  const before = kind === "discuss" ? next.findIndex((step) => step.kind === "implement") : kind === "review" ? next.findIndex((step) => step.kind === "fix") : -1;
  next.splice(before < 0 ? next.length : before, 0, newWorkflowStep(kind, steps));
  return next;
}

export function sanitizeWorkflowReuse(steps: WorkflowStepDto[]): WorkflowStepDto[] {
  return steps.map((step, index) => {
    if (!step.reuseStepId) return step;
    const source = steps.slice(0, index).find((candidate) => candidate.kind === "discuss" && candidate.id === step.reuseStepId && candidate.agentId === step.agentId);
    return source ? { ...step, profileRef: null, model: null, permission: null, reasoning: null }
      : { ...step, reuseStepId: null, profileRef: null, model: "default", permission: "bypassPermissions", reasoning: "default" };
  });
}

export function removeWorkflowStep(steps: readonly WorkflowStepDto[], id: string): WorkflowStepDto[] {
  if (steps.find((step) => step.id === id)?.kind === "implement") return [...steps];
  const remaining = steps.filter((step) => step.id !== id);
  return sanitizeWorkflowReuse(remaining.some((step) => step.kind === "review") ? remaining : remaining.filter((step) => step.kind !== "fix"));
}

export function canMoveWorkflowStep(steps: readonly WorkflowStepDto[], id: string, offset: -1 | 1): boolean {
  const index = steps.findIndex((step) => step.id === id);
  const step = steps[index];
  return step !== undefined && workflowHelper(step) && steps[index + offset]?.kind === step.kind;
}

export function moveWorkflowStep(steps: readonly WorkflowStepDto[], id: string, offset: -1 | 1): WorkflowStepDto[] {
  if (!canMoveWorkflowStep(steps, id, offset)) return [...steps];
  const next = [...steps];
  const index = next.findIndex((step) => step.id === id);
  [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
  return sanitizeWorkflowReuse(next);
}

export function workflowStepOwner(step: WorkflowStepDto, steps: readonly WorkflowStepDto[], lead: StewardAgentId, profiles: readonly AgentLibraryEntry[]): string {
  if (!workflowHelper(step)) return `${workflowAgentName(lead)} · lead agent`;
  const source = step.reuseStepId ? steps.find((candidate) => candidate.id === step.reuseStepId) : step;
  const profile = profiles.find((candidate) => candidate.id === source?.profileRef);
  return `${profile?.name ?? workflowAgentName(source?.agentId ?? step.agentId)} · ${step.reuseStepId ? `continues “${source?.title ?? "earlier discussion"}”` : "new conversation"}`;
}

export function workflowSummary(steps: readonly WorkflowStepDto[]): string {
  const discussions = steps.filter((step) => step.kind === "discuss").length;
  const reviews = steps.filter((step) => step.kind === "review").length;
  return [discussions ? `${discussions} discussion${discussions === 1 ? "" : "s"}` : undefined, "Implement", reviews ? `${reviews} reviewer${reviews === 1 ? "" : "s"}${reviews > 1 ? " in parallel" : ""}` : undefined, steps.some((step) => step.kind === "fix") ? "Fix if needed ↳ review again" : undefined].filter(Boolean).join(" → ");
}

export function workflowLaunchDefaults(capability: AgentCapabilityDto | undefined, profile?: AgentLibraryEntry): Pick<WorkflowDraft, "model" | "permission" | "reasoning"> {
  const choose = <T extends string>(options: readonly T[] | undefined, preferred: T, fallback: T): T => options?.includes(preferred) ? preferred : options?.includes(fallback) ? fallback : options?.[0] ?? fallback;
  return {
    model: choose(capability?.models, profile?.default_model ?? "default", "default"),
    permission: choose(capability?.permissions, profile?.permission ?? "bypassPermissions", "default"),
    reasoning: choose(capability?.reasoning, profile?.default_reasoning ?? "default", "default"),
  };
}

export function normalizedWorkflowDraft(draft: WorkflowDraft): WorkflowDraft {
  return { ...draft, name: draft.name.trim(), steps: draft.steps.map((step) => ({ ...step, title: step.title.trim(), instructions: step.instructions.trim() })) };
}

export function workflowDraftError(draft: WorkflowDraft): { message: string; stepId?: string } | undefined {
  if (!draft.name.trim()) return { message: "Give this template a name before saving." };
  if (!draft.steps.length) return { message: "Choose a starting point first." };
  const incomplete = draft.steps.find((step) => !step.title.trim() || !step.instructions.trim());
  if (incomplete) return { message: `Step ${draft.steps.indexOf(incomplete) + 1} needs ${!incomplete.title.trim() ? "a title" : "instructions"}.`, stepId: incomplete.id };
  return undefined;
}
