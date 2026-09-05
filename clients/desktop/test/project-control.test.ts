import { describe, expect, it } from "vitest";
import type { AgentStatus, BranchCommitSummary, GitHostProjection, Session, Task } from "../src/renderer/model.js";
import {
  deriveProjectControlSnapshot,
  deriveProjectControlTask,
  primaryProjectControlPullRequest,
} from "../src/renderer/project-control.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Ship control plane",
    brief: null,
    jira_url: "https://termloop.atlassian.net/browse/KAN-42",
    status: "open",
    archived_at_epoch_ms: null,
    branch: { repository_root: "/repo", name: "feature/control" },
    worktree: { path: "/worktree" },
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 2,
    worktree_generation: 1,
    worktree_health: {
      observation_sequence: 4,
      observed_at_epoch_ms: 4,
      path_state: "present",
      registration_state: "matching",
      head_state: "matching",
      launch_ready: true,
      checked_out_branch: "feature/control",
      change_count: 0,
      tracked_state: "clean",
      staged_state: "clean",
      untracked_state: "absent",
      ignored_state: "absent",
      submodule_state: "absent",
      worktree_lock_state: "absent",
      index_lock_state: "absent",
      upstream_state: "inSync",
      summary: "healthy",
    },
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    project_id: "project-1",
    name: null,
    kind: "Agent",
    lifecycle_state: "running",
    runtime_epoch: 7,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    retryable: false,
    closable: false,
    forkable: false,
    process: {
      program: "codex",
      args: [],
      cwd: "/worktree",
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: 1,
    },
    ...overrides,
  };
}

function status(value: AgentStatus["status"]): AgentStatus {
  return {
    sessionId: "session-1",
    status: value,
    source: "appServer",
    observedAtEpochMs: 10,
  };
}

function pullRequest(
  state: GitHostProjection["matches"][number]["state"],
  overrides: Partial<GitHostProjection["matches"][number]> = {},
): GitHostProjection["matches"][number] {
  return {
    provider: "github",
    host: "github.com",
    repository_owner: "termloop",
    repository_project: null,
    repository_name: "termloop",
    number: 42,
    title: "Project Control",
    url: "https://github.com/termloop/termloop/pull/42",
    state,
    merge_commit_oid: state === "merged" ? "a".repeat(40) : null,
    base_branch: "develop",
    head_branch: "feature/control",
    head_repository_owner: "termloop",
    head_repository_project: null,
    head_repository_name: "termloop",
    check_rollup: "passing",
    check_rollup_source: "githubStatusCheckRollup",
    review_signal: "approved",
    review_signal_source: "githubReviewDecision",
    merge_conflict: "noneDetected",
    merge_conflict_source: "githubMergeable",
    activity_at_epoch_ms: 20,
    activity_at_source: "githubUpdatedAt",
    ...overrides,
  };
}

function projection(matches: GitHostProjection["matches"]): GitHostProjection {
  return {
    usage: "displayOnly",
    task_id: "task-1",
    branch_name: "feature/control",
    repository_provider: "github",
    repository_host: "github.com",
    repository_owner: "termloop",
    repository_project: null,
    repository_name: "termloop",
    quality: matches.length ? "matches" : "repositoryResolved",
    freshness: "fresh",
    reason: null,
    matches,
    truncated: false,
    candidate_truncated: false,
    freshness_generation: 3,
    last_success_observed_at_epoch_ms: 20,
    last_attempt_observed_at_epoch_ms: 20,
  };
}

function commits(count: number): BranchCommitSummary {
  return {
    task_id: "task-1",
    count,
    base_ref: "refs/remotes/origin/develop",
    not_in_base: { count, base_ref: "refs/remotes/origin/develop", freshness: "fresh", reason: null },
    freshness: "fresh",
    reason: null,
  };
}

describe("Project Control reducer", () => {
  it("derives the five phases only from current facts", () => {
    const statuses = new Map<string, AgentStatus>();
    const ready = deriveProjectControlTask({ task: task(), sessions: [], statusesById: statuses, gitHostProjection: projection([]), branchCommitSummary: commits(0) });
    const building = deriveProjectControlTask({ task: task(), sessions: [session()], statusesById: new Map([["session-1", status("working")]]), gitHostProjection: projection([]), branchCommitSummary: commits(0) });
    const review = deriveProjectControlTask({ task: task(), sessions: [], statusesById: statuses, gitHostProjection: projection([pullRequest("open")]), branchCommitSummary: commits(2) });
    const landing = deriveProjectControlTask({ task: task(), sessions: [], statusesById: statuses, gitHostProjection: projection([pullRequest("merged")]), branchCommitSummary: commits(2) });
    const done = deriveProjectControlTask({ task: task({ status: "closed" }), sessions: [], statusesById: statuses, gitHostProjection: projection([pullRequest("merged")]), branchCommitSummary: commits(2) });

    expect([ready.phase, building.phase, review.phase, landing.phase, done.phase])
      .toEqual(["ready", "building", "review", "landing", "done"]);
    expect(ready.primaryAction?.kind).toBe("startAgent");
    expect(landing.primaryAction?.kind).toBe("closeTask");
    expect(done.primaryAction).toBeUndefined();
  });

  it("turns explicit unknowns and Agent attention into actionable facts", () => {
    const current = deriveProjectControlTask({
      task: task({ jira_url: null }),
      sessions: [session()],
      statusesById: new Map([["session-1", status("awaitingInput")]]),
      branchCommitSummary: { ...commits(0), count: null, freshness: "unavailable" },
    });

    expect(current.facts.find((fact) => fact.id === "issue")).toMatchObject({ value: "Not linked", tone: "unavailable" });
    expect(current.facts.find((fact) => fact.id === "commits")).toMatchObject({ value: "Not checked", tone: "unavailable" });
    expect(current.primaryAction).toMatchObject({ kind: "openAgent", sessionId: "session-1", priority: 0 });
  });

  it("chooses one stable primary PR and exposes ambiguity", () => {
    const olderOpen = pullRequest("open", { number: 40, activity_at_epoch_ms: 10 });
    const newerDraft = pullRequest("draft", { number: 41, activity_at_epoch_ms: 30 });
    const merged = pullRequest("merged", { number: 39, activity_at_epoch_ms: 40 });
    const source = projection([merged, newerDraft, olderOpen]);

    expect(primaryProjectControlPullRequest(source)?.number).toBe(40);
    const current = deriveProjectControlTask({ task: task(), sessions: [], statusesById: new Map(), gitHostProjection: source, branchCommitSummary: commits(3) });
    expect(current.facts.find((fact) => fact.id === "pullRequest")).toMatchObject({ value: "2 possible PRs", tone: "attention" });
    expect(current.primaryAction?.summary).toContain("More than one PR");
  });

  it("orders the Action Inbox by urgency without storing lane positions", () => {
    const awaitingTask = task({ id: "awaiting", rank: 1, title: "Awaiting" });
    const landingTask = task({ id: "landing", rank: 0, title: "Landing" });
    const awaitingSession = session({ id: "awaiting-session" });
    const awaitingStatus = { ...status("awaitingInput"), sessionId: "awaiting-session" };
    const snapshot = deriveProjectControlSnapshot([
      { task: landingTask, sessions: [], statusesById: new Map(), gitHostProjection: { ...projection([pullRequest("merged")]), task_id: "landing" }, branchCommitSummary: { ...commits(2), task_id: "landing" } },
      { task: awaitingTask, sessions: [awaitingSession], statusesById: new Map([["awaiting-session", awaitingStatus]]), gitHostProjection: { ...projection([]), task_id: "awaiting" }, branchCommitSummary: { ...commits(0), task_id: "awaiting" } },
    ]);

    expect(snapshot.inbox.map((item) => item.kind)).toEqual(["closeTask", "openAgent"]);
    expect(snapshot.phases.landing.map((item) => item.task.id)).toEqual(["landing"]);
    expect(snapshot.phases.building.map((item) => item.task.id)).toEqual(["awaiting"]);
  });
});
