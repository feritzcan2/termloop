import type { AgentStatus, BranchCommitSummary, GitHostProjection, Session, Task } from "./model.js";
import { isLiveSession, taskHasWorktreeChanges } from "./model.js";

export type ProjectControlPhase = "ready" | "building" | "review" | "landing" | "done";
export type ProjectControlFactTone = "quiet" | "active" | "attention" | "unavailable" | "done";
export type ProjectControlActionKind =
  | "prepareWorkspace"
  | "startAgent"
  | "openAgent"
  | "inspectChanges"
  | "inspectCommits"
  | "openPullRequest"
  | "closeTask";

export type ProjectControlFact = {
  id: "issue" | "workspace" | "agent" | "commits" | "pullRequest" | "checks" | "review";
  label: string;
  value: string;
  tone: ProjectControlFactTone;
  detail: string;
};

export type ProjectControlAction = {
  id: string;
  kind: ProjectControlActionKind;
  taskId: string;
  label: string;
  summary: string;
  priority: number;
  sessionId?: string | undefined;
  pullRequest?: GitHostProjection["matches"][number] | undefined;
};

export type ProjectControlTask = {
  task: Task;
  phase: ProjectControlPhase;
  phaseLabel: string;
  facts: readonly ProjectControlFact[];
  actions: readonly ProjectControlAction[];
  primaryAction: ProjectControlAction | undefined;
  primaryPullRequest: GitHostProjection["matches"][number] | undefined;
  liveAgentSession: Session | undefined;
  factRevision: string;
};

export type ProjectControlSnapshot = {
  tasks: readonly ProjectControlTask[];
  phases: Readonly<Record<ProjectControlPhase, readonly ProjectControlTask[]>>;
  inbox: readonly ProjectControlAction[];
  attentionTaskCount: number;
};

export const PROJECT_CONTROL_PHASES = [
  { id: "ready", label: "Not started" },
  { id: "building", label: "In progress" },
  { id: "review", label: "In review" },
  { id: "landing", label: "Merged" },
  { id: "done", label: "Completed" },
] as const satisfies readonly { id: ProjectControlPhase; label: string }[];

const pullRequestStateOrder: Readonly<Record<GitHostProjection["matches"][number]["state"], number>> = {
  open: 0,
  draft: 1,
  merged: 2,
  closed: 3,
};

export function primaryProjectControlPullRequest(
  projection: GitHostProjection | undefined,
): GitHostProjection["matches"][number] | undefined {
  return projection ? [...projection.matches].sort((left, right) =>
    pullRequestStateOrder[left.state] - pullRequestStateOrder[right.state]
      || right.activity_at_epoch_ms - left.activity_at_epoch_ms
      || right.number - left.number)[0] : undefined;
}

function currentAgentStatus(
  sessions: readonly Session[],
  statusesById: ReadonlyMap<string, AgentStatus>,
): { session: Session | undefined; status: AgentStatus["status"] | undefined } {
  const liveAgents = sessions
    .filter((session) => session.kind === "Agent" && isLiveSession(session))
    .slice()
    .sort((left, right) => right.runtime_epoch - left.runtime_epoch);
  const preferred = liveAgents.find((session) => {
    const status = statusesById.get(session.id)?.status;
    return status === "awaitingInput" || status === "failed" || status === "interrupted";
  }) ?? liveAgents[0];
  return { session: preferred, status: preferred ? statusesById.get(preferred.id)?.status : undefined };
}

function phaseFor(
  task: Task,
  pullRequest: GitHostProjection["matches"][number] | undefined,
  commitCount: number | null,
  hasChanges: boolean,
  liveAgent: Session | undefined,
): ProjectControlPhase {
  if (task.status === "closed") return "done";
  if (pullRequest?.state === "merged") return "landing";
  if (pullRequest) return "review";
  if (liveAgent || hasChanges || (commitCount ?? 0) > 0) return "building";
  return "ready";
}

function phaseLabel(phase: ProjectControlPhase): string {
  return PROJECT_CONTROL_PHASES.find((candidate) => candidate.id === phase)?.label ?? phase;
}

function action(
  taskId: string,
  factRevision: string,
  kind: ProjectControlActionKind,
  label: string,
  summary: string,
  priority: number,
  extra: Pick<ProjectControlAction, "sessionId" | "pullRequest"> = {},
): ProjectControlAction {
  return { id: `${taskId}:${kind}:${factRevision}`, kind, taskId, label, summary, priority, ...extra };
}

function workspaceFact(task: Task): ProjectControlFact {
  if (!task.worktree) {
    return { id: "workspace", label: "Worktree", value: "Not prepared", tone: "attention", detail: "This Task has no managed worktree." };
  }
  const summary = task.worktree_health?.summary;
  if (!summary) {
    return { id: "workspace", label: "Worktree", value: "Not checked", tone: "unavailable", detail: "Worktree health has not been observed yet." };
  }
  if (summary === "healthy") {
    return { id: "workspace", label: "Worktree", value: "Ready", tone: "quiet", detail: "The managed worktree is ready." };
  }
  return {
    id: "workspace",
    label: "Worktree",
    value: summary === "attention" ? "Needs attention" : "Not available",
    tone: "attention",
    detail: summary === "attention" ? "The worktree needs attention." : "Worktree health could not be proven.",
  };
}

function agentFact(session: Session | undefined, status: AgentStatus["status"] | undefined): ProjectControlFact {
  if (!session) {
    return { id: "agent", label: "Agent", value: "No active agent", tone: "quiet", detail: "No Agent is currently running in this Task." };
  }
  const rawValue = status ?? (session.lifecycle_state === "resuming" ? "resuming" : "status unknown");
  const statusLabels: Record<string, string> = {
    working: "Working",
    compacting: "Working",
    awaitingInput: "Needs input",
    failed: "Failed",
    interrupted: "Interrupted",
    idle: "Idle",
    resuming: "Starting",
    "status unknown": "Not checked",
    unknown: "Not checked",
    exited: "Stopped",
  };
  const value = statusLabels[rawValue] ?? rawValue;
  const tone: ProjectControlFactTone = status === "working" || status === "compacting" || session.lifecycle_state === "resuming"
    ? "active"
    : status === "awaitingInput" || status === "failed" || status === "interrupted"
      ? "attention"
      : status ? "quiet" : "unavailable";
  return { id: "agent", label: "Agent", value, tone, detail: `Session ${session.id} is ${value.toLowerCase()}.` };
}

function commitFact(summary: BranchCommitSummary | undefined): ProjectControlFact {
  if (!summary || summary.freshness !== "fresh" || summary.count === null) {
    return { id: "commits", label: "Commits", value: "Not checked", tone: "unavailable", detail: "The branch commit count is unavailable or stale." };
  }
  return {
    id: "commits",
    label: "Commits",
    value: String(summary.count),
    tone: summary.count > 0 ? "active" : "quiet",
    detail: `${summary.count} commit${summary.count === 1 ? "" : "s"} are not in ${summary.base_ref ?? "the base branch"}.`,
  };
}

function pullRequestFacts(
  projection: GitHostProjection | undefined,
  pullRequest: GitHostProjection["matches"][number] | undefined,
): ProjectControlFact[] {
  if (!projection || projection.freshness === "unavailable") {
    return [{ id: "pullRequest", label: "Pull request", value: "Not available", tone: "unavailable", detail: "Pull-request facts could not be observed." }];
  }
  if (projection.freshness === "stale") {
    return [{ id: "pullRequest", label: "Pull request", value: "Refreshing", tone: "unavailable", detail: "Pull-request facts are being refreshed." }];
  }
  if (!pullRequest) {
    return [{ id: "pullRequest", label: "Pull request", value: "No PR", tone: "quiet", detail: "No pull request matches the Task branch." }];
  }
  const activeMatches = projection.matches.filter((candidate) => candidate.state === "open" || candidate.state === "draft");
  const prTone: ProjectControlFactTone = pullRequest.state === "merged" ? "done"
    : pullRequest.state === "closed" || activeMatches.length > 1 ? "attention"
      : "active";
  const prValue = activeMatches.length > 1
    ? `${activeMatches.length} possible PRs`
    : `#${pullRequest.number} · ${pullRequest.state[0]?.toUpperCase()}${pullRequest.state.slice(1)}`;
  return [
    {
      id: "pullRequest",
      label: "Pull request",
      value: prValue,
      tone: prTone,
      detail: activeMatches.length > 1
        ? "More than one active pull request matches this Task branch; inspect the candidates before acting."
        : pullRequest.title,
    },
    {
      id: "checks",
      label: "CI",
      value: {
        passing: "Passing",
        failing: "Failing",
        pending: "Running",
        notReported: "Not reported",
        unsupported: "Open PR to check",
        unknown: "Unknown",
      }[pullRequest.check_rollup],
      tone: pullRequest.check_rollup === "passing" ? "done"
        : pullRequest.check_rollup === "pending" ? "active"
          : "attention",
      detail: `The provider reports checks as ${pullRequest.check_rollup}.`,
    },
    {
      id: "review",
      label: "Review",
      value: {
        approved: "Approved",
        changesRequested: "Changes requested",
        reviewRequired: "Waiting for review",
        notReported: "Not reported",
        unknown: "Unknown",
      }[pullRequest.review_signal],
      tone: pullRequest.review_signal === "approved" ? "done"
        : pullRequest.review_signal === "reviewRequired" ? "active"
          : "attention",
      detail: `The provider reports review as ${pullRequest.review_signal}.`,
    },
  ];
}

function actionsFor(
  task: Task,
  phase: ProjectControlPhase,
  factRevision: string,
  session: Session | undefined,
  status: AgentStatus["status"] | undefined,
  pullRequest: GitHostProjection["matches"][number] | undefined,
  projection: GitHostProjection | undefined,
  commitCount: number | null,
  hasChanges: boolean,
): ProjectControlAction[] {
  if (phase === "done") return [];
  if (phase === "landing") {
    return [action(task.id, factRevision, "closeTask", "Finish task", "The pull request is merged. Mark this Task complete.", 0)];
  }
  if (phase === "review" && pullRequest) {
    const activeMatches = projection?.matches.filter((candidate) => candidate.state === "open" || candidate.state === "draft") ?? [];
    let summary = "Inspect the pull request and its current provider facts.";
    if (activeMatches.length > 1) summary = "More than one PR matches this branch. Open them and choose the right one.";
    else if (pullRequest.merge_conflict === "conflicting") summary = "This PR has merge conflicts. Open it to resolve them.";
    else if (pullRequest.merge_conflict === "policyBlocked") summary = "A repository policy is blocking this PR. Open it to see what is required.";
    else if (pullRequest.check_rollup === "failing") summary = "Some CI checks failed. Open the PR to see which ones.";
    else if (pullRequest.check_rollup === "pending") summary = "CI checks are still running. Open the PR for the latest result.";
    else if (pullRequest.check_rollup === "unsupported" || pullRequest.check_rollup === "notReported" || pullRequest.check_rollup === "unknown") summary = "TermLoop cannot show CI for this PR. Open it to check the current result.";
    else if (pullRequest.review_signal === "changesRequested") summary = "The reviewer requested changes. Open the PR to see the comments.";
    else if (pullRequest.review_signal === "reviewRequired") summary = "This PR is waiting for review.";
    else if (pullRequest.review_signal === "notReported" || pullRequest.review_signal === "unknown") summary = "Open the PR to check its review status.";
    else if (pullRequest.state === "draft") summary = "Checks and review are ready; decide whether to mark the pull request ready.";
    else if (pullRequest.state === "open") summary = "Checks pass and review is approved; the pull request is ready to land.";
    else summary = "The pull request closed without merging; decide whether to reopen or replace it.";
    return [action(task.id, factRevision, "openPullRequest", `Review PR #${pullRequest.number}`, summary, 1, { pullRequest })];
  }
  if (session && (status === "awaitingInput" || status === "failed" || status === "interrupted")) {
    return [action(task.id, factRevision, "openAgent", "Agent needs you", status === "awaitingInput" ? "The Agent is waiting for your input." : `The Agent stopped with status: ${status}.`, 0, { sessionId: session.id })];
  }
  if (hasChanges) {
    return [action(task.id, factRevision, "inspectChanges", "Review local changes", "This Task has uncommitted changes.", 2)];
  }
  if ((commitCount ?? 0) > 0) {
    return [action(task.id, factRevision, "inspectCommits", "Review commits", "This branch has commits but no pull request yet.", 2)];
  }
  if (!task.worktree) {
    return [action(task.id, factRevision, "prepareWorkspace", "Prepare this task", "Create a branch and worktree so work can start.", 1)];
  }
  if (!session) {
    return [action(task.id, factRevision, "startAgent", "Start work", "The Task is ready. Start an Agent when you want to work on it.", 3)];
  }
  return [];
}

export function deriveProjectControlTask(input: {
  task: Task;
  gitHostProjection?: GitHostProjection | undefined;
  branchCommitSummary?: BranchCommitSummary | undefined;
  sessions: readonly Session[];
  statusesById: ReadonlyMap<string, AgentStatus>;
}): ProjectControlTask {
  const { task, gitHostProjection, branchCommitSummary, sessions, statusesById } = input;
  const pullRequest = primaryProjectControlPullRequest(gitHostProjection);
  const commitCount = branchCommitSummary?.freshness === "fresh" ? branchCommitSummary.count : null;
  const hasChanges = taskHasWorktreeChanges(task);
  const agent = currentAgentStatus(sessions, statusesById);
  const phase = phaseFor(task, pullRequest, commitCount, hasChanges, agent.session);
  const factRevision = [
    task.updated_at_epoch_ms,
    task.worktree_health?.observation_sequence ?? 0,
    gitHostProjection?.freshness_generation ?? 0,
    branchCommitSummary?.count ?? "x",
    agent.session?.runtime_epoch ?? 0,
    agent.session ? statusesById.get(agent.session.id)?.observedAtEpochMs ?? 0 : 0,
  ].join(".");
  const facts: ProjectControlFact[] = [
    task.jira_url
      ? { id: "issue", label: "Issue", value: task.jira_url.slice(task.jira_url.lastIndexOf("/") + 1), tone: "quiet", detail: "A Jira issue is linked to this Task." }
      : { id: "issue", label: "Issue", value: "Not linked", tone: "unavailable", detail: "No Jira issue is linked; issue state is explicitly unknown." },
    workspaceFact(task),
    agentFact(agent.session, agent.status),
    commitFact(branchCommitSummary),
    ...pullRequestFacts(gitHostProjection, pullRequest),
  ];
  const actions = actionsFor(
    task,
    phase,
    factRevision,
    agent.session,
    agent.status,
    pullRequest,
    gitHostProjection,
    commitCount,
    hasChanges,
  );
  return {
    task,
    phase,
    phaseLabel: phaseLabel(phase),
    facts,
    actions,
    primaryAction: actions[0],
    primaryPullRequest: pullRequest,
    liveAgentSession: agent.session,
    factRevision,
  };
}

export function deriveProjectControlSnapshot(inputs: readonly {
  task: Task;
  gitHostProjection?: GitHostProjection | undefined;
  branchCommitSummary?: BranchCommitSummary | undefined;
  sessions: readonly Session[];
  statusesById: ReadonlyMap<string, AgentStatus>;
}[]): ProjectControlSnapshot {
  const tasks = inputs
    .map(deriveProjectControlTask)
    .sort((left, right) => left.task.rank - right.task.rank || left.task.title.localeCompare(right.task.title));
  const phases = Object.fromEntries(PROJECT_CONTROL_PHASES.map(({ id }) => [
    id,
    tasks.filter((task) => task.phase === id),
  ])) as Record<ProjectControlPhase, ProjectControlTask[]>;
  const inbox = tasks
    .flatMap((task) => task.primaryAction ? [task.primaryAction] : [])
    .sort((left, right) => left.priority - right.priority
      || tasks.findIndex((task) => task.task.id === left.taskId) - tasks.findIndex((task) => task.task.id === right.taskId));
  return {
    tasks,
    phases,
    inbox,
    attentionTaskCount: new Set(inbox.map((item) => item.taskId)).size,
  };
}
