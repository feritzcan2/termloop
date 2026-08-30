import { describe, expect, it } from "vitest";
import type { BranchCommitSummary, GitHostProjection, Task } from "../src/renderer/model.js";
import {
  integrationTone,
  provisioningFailureKinds,
  provisioningFailureNote,
  taskChangeCount,
  taskDivergence,
  taskIntegration,
  taskNextStep,
  taskPrimaryAction,
  taskRowAccessibleName,
  taskRowTone,
  taskStage,
} from "../src/renderer/task-presentation.js";
import type { AgentAttention } from "../src/renderer/session-presentation.js";

function health(overrides: Partial<NonNullable<Task["worktree_health"]>> = {}): NonNullable<Task["worktree_health"]> {
  return {
    observation_sequence: 1,
    observed_at_epoch_ms: 1,
    path_state: "present",
    registration_state: "matching",
    head_state: "matching",
    launch_ready: true,
    checked_out_branch: "feature/work",
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
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Ship the thing",
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: null,
    status: "open",
    branch: { repository_root: "/repo", name: "feature/work" },
    worktree: { path: "/repo/.worktrees/work" },
    worktree_generation: 1,
    worktree_health: health(),
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
    ...overrides,
  } as Task;
}

function unprovisioned(overrides: Partial<Task> = {}): Task {
  const { worktree_generation: _generation, worktree_health: _health, ...rest } = task();
  return { ...rest, worktree: null, ...overrides } as Task;
}

const attention = (tone: AgentAttention["tone"]): AgentAttention => ({
  sessionId: "session-1",
  label: tone === "attention" ? "Needs input" : tone === "review" ? "Needs review" : "Working",
  agent: "Claude",
  tone,
});

describe("Task stage", () => {
  it("ranks a deletion, then provisioning, then worktree health", () => {
    expect(taskStage(task(), true)).toMatchObject({ id: "deleting", tone: "busy", flag: "Deleting" });
    expect(taskStage(unprovisioned({ branch: null }), false, true)).toMatchObject({ id: "provisioning", tone: "busy", flag: "Creating" });

    const running = task({ worktree_provisioning: { status: "running", operation_id: "op" } as never });
    expect(taskStage(running, false)).toMatchObject({ id: "provisioning", tone: "busy", flag: "Creating" });

    const failed = unprovisioned({ worktree_provisioning: { status: "failed", operation_id: "op", failure: { kind: "worktreeLocked" } } as never });
    expect(taskStage(failed, false)).toMatchObject({ id: "provisioningFailed", tone: "blocked", flag: "Failed" });

    /// A deletion in flight outranks a failure that is already recorded.
    expect(taskStage(failed, true).id).toBe("deleting");
  });

  it("leaves the early and closed stages unflagged so the title keeps its width", () => {
    expect(taskStage(unprovisioned(), false)).toMatchObject({ id: "branchOnly", tone: "quiet", flag: undefined });
    expect(taskStage(unprovisioned({ branch: null }), false)).toMatchObject({ id: "planning", tone: "quiet", flag: undefined });
    expect(taskStage(task({ status: "closed" }), false)).toMatchObject({ id: "closed", tone: "quiet", flag: undefined });
    expect(taskStage(task(), false)).toMatchObject({ id: "ready", tone: "quiet", flag: undefined });
  });

  it("treats a new worktree awaiting its first health observation as in progress", () => {
    const { worktree_health: _health, ...awaitingHealth } = task();
    expect(taskStage(awaitingHealth, false)).toMatchObject({
      id: "observing",
      tone: "busy",
      flag: "Checking",
      summary: "Checking this worktree before launch.",
    });
  });

  it("separates a repairable link from an unlaunchable checkout and explains each", () => {
    const repairable = task({ worktree_health: health({ launch_ready: false, path_state: "absent", summary: "attention" }) });
    expect(taskStage(repairable, false)).toMatchObject({ id: "repair", tone: "blocked", flag: "Needs repair" });

    const headMismatch = task({ worktree_health: health({ launch_ready: false, head_state: "mismatch", summary: "attention" }) });
    const stage = taskStage(headMismatch, false);
    expect(stage).toMatchObject({ id: "unavailable", tone: "blocked", flag: "Unavailable" });
    expect(stage.note).toBe("The checkout HEAD does not match its registration.");
  });

  /// A half-removed folder still reports present-and-unlaunchable health, so the
  /// health sentences alone would call it unproven and hide the interrupted
  /// deletion that actually caused it.
  it("names an interrupted folder deletion ahead of the health sentences", () => {
    const interrupted = task({
      worktree_health: health({ launch_ready: false, registration_state: "absent", summary: "attention" }),
      worktree_stale_resolution: {
        operation_id: "op",
        managed_worktree_operation_id: "managed-op",
        worktree_generation: 1,
        target_path: "/repo/.worktrees/work",
        mode: "discardDirectory",
        stage: "removalPrepared",
        status: "failed",
        failure: { kind: "recoveryAttention", blockers: ["recoveryAttention"] },
      },
    } as never);
    const stage = taskStage(interrupted, false);
    expect(stage).toMatchObject({ id: "unavailable", tone: "blocked", flag: "Unavailable" });
    expect(stage.note).toBe("A folder deletion was interrupted, so this checkout is partly removed. Delete the Task again to finish it.");

    /// A resolution that is still running, or one that failed for a reason the
    /// user can act on directly, must not claim an interrupted deletion.
    const running = task({
      worktree_health: health({ launch_ready: false, registration_state: "absent", summary: "attention" }),
      worktree_stale_resolution: {
        operation_id: "op",
        managed_worktree_operation_id: "managed-op",
        worktree_generation: 1,
        target_path: "/repo/.worktrees/work",
        mode: "discardDirectory",
        stage: "removalPrepared",
        status: "running",
        failure: null,
      },
    } as never);
    expect(taskStage(running, false).note).toBe("TermLoop cannot prove this checkout is safe to launch in.");
  });

  /// A raw contract enum is not a sentence a user can act on. The kinds come from
  /// the map itself so a new contract member cannot be forgotten in two places —
  /// the map is a total Record, so the type check is what enforces coverage.
  it("turns every provisioning failure kind into plain language", () => {
    const kinds = provisioningFailureKinds();
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const stage = taskStage(unprovisioned({ worktree_provisioning: { status: "failed", operation_id: "op", failure: { kind } } as never }), false);
      expect(stage.note, kind).toBeTruthy();
      expect(stage.note, kind).not.toContain(kind);
      expect(stage.note!.endsWith("."), kind).toBe(true);
    }
  });

  /// A daemon ahead of this build can put a kind on the wire that this client has
  /// never heard of. A blocked Task must still explain itself rather than showing
  /// a bare FAILED flag with no sentence under it.
  it("explains an absent or unrecognized failure kind instead of falling silent", () => {
    expect(provisioningFailureNote(undefined)).toBe("Git refused to create the worktree.");
    expect(provisioningFailureNote("kindFromANewerDaemon" as never)).toBe("Git refused to create the worktree.");

    const noDetail = unprovisioned({ worktree_provisioning: { status: "failed", operation_id: "op" } as never });
    expect(taskStage(noDetail, false).note).toBe("Git refused to create the worktree.");
  });
});

describe("Task next step", () => {
  it("offers an optional worktree, a required retry, and a required repair", () => {
    expect(taskNextStep(taskStage(unprovisioned({ branch: null }), false))).toEqual({ kind: "createWorktree", label: "Create worktree", emphasis: "optional" });
    expect(taskNextStep(taskStage(unprovisioned(), false))).toEqual({ kind: "createWorktree", label: "Create worktree", emphasis: "optional" });

    const failed = unprovisioned({ worktree_provisioning: { status: "failed", operation_id: "op", failure: { kind: "timeout" } } as never });
    expect(taskNextStep(taskStage(failed, false))).toEqual({ kind: "retryWorktree", label: "Retry worktree", emphasis: "recovery" });

    const repairable = task({ worktree_health: health({ launch_ready: false, registration_state: "mismatch", summary: "attention" }) });
    expect(taskNextStep(taskStage(repairable, false))).toEqual({ kind: "repairWorktree", label: "Repair worktree", emphasis: "recovery" });
  });

  /// A healthy or busy Task must not nag: its launchers are the affordance, and
  /// a second accent would compete with the rows that are genuinely stuck.
  it("offers nothing for a healthy, busy, closed, or deleting Task", () => {
    expect(taskNextStep(taskStage(task(), false))).toBeUndefined();
    expect(taskNextStep(taskStage(task({ worktree_provisioning: { status: "running", operation_id: "op" } as never }), false))).toBeUndefined();
    expect(taskNextStep(taskStage(task({ status: "closed" }), false))).toBeUndefined();
    expect(taskNextStep(taskStage(task(), true))).toBeUndefined();
    expect(taskNextStep(taskStage(task({ worktree_health: health({ launch_ready: false, head_state: "missing", summary: "attention" }) }), false))).toBeUndefined();
  });
});

describe("Task primary action", () => {
  it("ranks a recovery step above a waiting agent above an optional step", () => {
    const failed = unprovisioned({ worktree_provisioning: { status: "failed", operation_id: "op", failure: { kind: "timeout" } } as never });
    expect(taskPrimaryAction(taskStage(failed, false), attention("attention")))
      .toEqual({ kind: "nextStep", nextStep: { kind: "retryWorktree", label: "Retry worktree", emphasis: "recovery" } });

    expect(taskPrimaryAction(taskStage(unprovisioned(), false), attention("attention")))
      .toEqual({ kind: "agent", attention: attention("attention") });
    expect(taskPrimaryAction(taskStage(task(), false), attention("review")))
      .toEqual({ kind: "agent", attention: attention("review") });

    expect(taskPrimaryAction(taskStage(unprovisioned(), false), undefined))
      .toEqual({ kind: "nextStep", nextStep: { kind: "createWorktree", label: "Create worktree", emphasis: "optional" } });
  });

  it("treats a working agent as progress, not a request, and offers a deleting Task nothing", () => {
    expect(taskPrimaryAction(taskStage(task(), false), attention("working"))).toBeUndefined();
    expect(taskPrimaryAction(taskStage(unprovisioned(), false), attention("working")))
      .toEqual({ kind: "nextStep", nextStep: { kind: "createWorktree", label: "Create worktree", emphasis: "optional" } });
    expect(taskPrimaryAction(taskStage(task(), true), attention("attention"))).toBeUndefined();
    expect(taskPrimaryAction(taskStage(task(), false), undefined)).toBeUndefined();
  });
});

describe("Task row tone", () => {
  it("lets a waiting agent outrank a quiet or busy stage but never a blocker", () => {
    const ready = taskStage(task(), false);
    const creating = taskStage(task({ worktree_provisioning: { status: "running", operation_id: "op" } as never }), false);
    const blocked = taskStage(task({ worktree_health: health({ launch_ready: false, path_state: "absent", summary: "attention" }) }), false);

    expect(taskRowTone(ready, undefined)).toBe("quiet");
    expect(taskRowTone(ready, attention("attention"))).toBe("attention");
    expect(taskRowTone(ready, attention("working"))).toBe("working");
    expect(taskRowTone(creating, attention("attention"))).toBe("attention");
    expect(taskRowTone(creating, attention("working"))).toBe("busy");
    expect(taskRowTone(blocked, attention("attention"))).toBe("blocked");
  });
});

describe("Task facts", () => {
  it("reports a change count only when the health projection says work exists", () => {
    expect(taskChangeCount(task())).toBeUndefined();
    expect(taskChangeCount(task({ worktree_health: health({ tracked_state: "changed", change_count: 4 }) }))).toBe(4);
    /// A changed tri-state with a zero count is not a number worth printing.
    expect(taskChangeCount(task({ worktree_health: health({ tracked_state: "changed", change_count: 0 }) }))).toBeUndefined();
  });

  it("names the divergent checkout branch and both branches in its explanation", () => {
    expect(taskDivergence(task())).toBeUndefined();
    const diverged = taskDivergence(task({ worktree_health: health({ checked_out_branch: "main" }) }));
    expect(diverged).toMatchObject({ branch: "main", text: "on main" });
    expect(diverged!.title).toContain("main");
    expect(diverged!.title).toContain("feature/work");
  });

  it("downgrades a settled integration while local changes remain", () => {
    const summary: BranchCommitSummary = {
      task_id: "task-1",
      count: 3,
      base_ref: "refs/heads/main",
      not_in_base: { count: 0, base_ref: "refs/heads/main", freshness: "fresh", reason: null },
      freshness: "fresh",
      reason: null,
    } as never;
    const integration = taskIntegration(undefined, summary)!;
    expect(integration).toMatchObject({ tone: "done", label: "In base" });
    expect(integrationTone(integration, false)).toBe("done");
    expect(integrationTone(integration, true)).toBe("attention");
  });

  it("keeps a local base comparison ahead of a provider merge claim", () => {
    const projection = {
      task_id: "task-1", branch_name: "feature/work", repository_provider: "github", repository_host: "github.com",
      repository_owner: "o", repository_project: null, repository_name: "r", quality: "matches", freshness: "fresh", reason: null,
      matches: [{
        provider: "github", host: "github.com", repository_owner: "o", repository_project: null, repository_name: "r",
        number: 7, title: "Ship", url: "https://example.test/7", state: "merged", base_branch: "main",
        head_branch: "feature/work", head_repository_owner: "o", head_repository_project: null, head_repository_name: "r",
        check_rollup: "passing", check_rollup_source: "githubStatusCheckRollup",
        review_signal: "approved", review_signal_source: "githubReviewDecision",
        merge_conflict: "unknown", merge_conflict_source: "githubMergeable",
        activity_at_epoch_ms: 1, activity_at_source: "githubUpdatedAt",
      }],
      truncated: false, candidate_truncated: false, freshness_generation: 1,
      last_success_observed_at_epoch_ms: 1, last_attempt_observed_at_epoch_ms: 1,
    } as unknown as GitHostProjection;
    const stillUnmerged = {
      task_id: "task-1", count: 5, base_ref: "refs/heads/main",
      not_in_base: { count: 2, base_ref: "refs/heads/main", freshness: "fresh", reason: null },
      freshness: "fresh", reason: null,
    } as unknown as BranchCommitSummary;

    expect(taskIntegration(projection, stillUnmerged)).toMatchObject({ tone: "attention", label: "2 unmerged", action: "commits" });
    expect(taskIntegration(projection, undefined)).toMatchObject({ tone: "done", label: "Merged", action: "pullRequest" });
  });

  it("does not describe open PR branches with the durable Task branch base result", () => {
    const projection = {
      task_id: "task-1", branch_name: "termloop/generated", repository_provider: "github", repository_host: "github.com",
      repository_owner: "o", repository_project: null, repository_name: "r", quality: "matches", freshness: "fresh", reason: null,
      matches: [{
        provider: "github", host: "github.com", repository_owner: "o", repository_project: null, repository_name: "r",
        number: 7, title: "Ship", url: "https://example.test/7", state: "open", base_branch: "development",
        head_branch: "UKIE-804", head_repository_owner: "o", head_repository_project: null, head_repository_name: "r",
        check_rollup: "pending", check_rollup_source: "githubStatusCheckRollup",
        review_signal: "reviewRequired", review_signal_source: "githubReviewDecision",
        merge_conflict: "noneDetected", merge_conflict_source: "githubMergeable",
        activity_at_epoch_ms: 1, activity_at_source: "githubUpdatedAt",
      }],
      truncated: false, candidate_truncated: false, freshness_generation: 1,
      last_success_observed_at_epoch_ms: 1, last_attempt_observed_at_epoch_ms: 1,
    } as unknown as GitHostProjection;
    const durableBranchInBase = {
      task_id: "task-1", count: 0, base_ref: "refs/heads/development",
      not_in_base: { count: 0, base_ref: "refs/heads/development", freshness: "fresh", reason: null },
      freshness: "fresh", reason: null,
    } as unknown as BranchCommitSummary;

    expect(taskIntegration(projection, durableBranchInBase)).toMatchObject({
      tone: "quiet",
      label: "Checks pending",
      action: "pullRequest",
    });

    projection.matches[0]!.check_rollup = "passing";
    projection.matches[0]!.review_signal = "approved";
    expect(taskIntegration(projection, durableBranchInBase)).toMatchObject({
      tone: "review",
      label: "Signals positive",
      action: "pullRequest",
    });

    projection.matches[0]!.provider = "azureDevOps";
    projection.matches[0]!.check_rollup = "unsupported";
    projection.matches[0]!.check_rollup_source = "unsupported";
    projection.matches[0]!.review_signal_source = "azureRequiredReviewerVotes";
    projection.matches[0]!.merge_conflict_source = "azureMergeStatus";
    projection.matches[0]!.activity_at_source = "azureLifecycleApproximation";
    expect(taskIntegration(projection, durableBranchInBase)).toMatchObject({
      tone: "quiet",
      label: "CI not observed",
      action: "pullRequest",
    });

    projection.matches[0]!.merge_conflict = "policyBlocked";
    expect(taskIntegration(projection, durableBranchInBase)).toMatchObject({
      tone: "attention",
      label: "Policy blocked",
      action: "pullRequest",
    });
  });
});

describe("Task row accessible name", () => {
  it("carries the stage sentence, the waiting agent, and every derived count", () => {
    const subject = task({ jira_url: "https://issues.test/browse/TERM-9", worktree_health: health({ tracked_state: "changed", change_count: 2 }) });
    const stage = taskStage(subject, false);
    const name = taskRowAccessibleName({
      task: subject,
      stage,
      attention: attention("attention"),
      divergence: taskDivergence(subject),
      changeCount: 2,
      integration: { tone: "done", label: "Merged", title: "", action: "pullRequest", pullRequest: undefined },
      commitCount: 6,
    });

    expect(name).toContain("Ship the thing");
    expect(name).toContain("branch feature/work");
    expect(name).toContain("worktree attached");
    expect(name).toContain("worktree folder work");
    expect(name).toContain("Ready to run agents.");
    /// A Task that never ran a provisioning operation says nothing about one.
    expect(name).not.toContain("provisioning");
    expect(name).toContain("Needs input, Claude");
    expect(name).toContain("2 changed files");
    expect(name).toContain("Merged, local changes remain");
    expect(name).toContain("6 Task commits");
    expect(name).toContain("Jira TERM-9");
  });

  /// tests/e2e/f2/worktree-provisioning.mjs asserts these exact phrases on the
  /// row's aria-label, so they are a published acceptance contract.
  it("keeps the phrases the F2 provisioning acceptance script asserts", () => {
    const attached = task();
    expect(taskRowAccessibleName({
      task: attached,
      stage: taskStage(attached, false),
      attention: undefined,
      divergence: undefined,
      changeCount: undefined,
      integration: undefined,
      commitCount: null,
    })).toContain("worktree attached");

    const failed = unprovisioned({ worktree_provisioning: { status: "failed", operation_id: "op", failure: { kind: "recoveryAttention" } } as never });
    expect(taskRowAccessibleName({
      task: failed,
      stage: taskStage(failed, false),
      attention: undefined,
      divergence: undefined,
      changeCount: undefined,
      integration: undefined,
      commitCount: null,
    })).toContain("worktree provisioning failed");
  });

  it("omits every derived part a Task does not have", () => {
    const subject = unprovisioned({ branch: null });
    const name = taskRowAccessibleName({
      task: subject,
      stage: taskStage(subject, false),
      attention: undefined,
      divergence: undefined,
      changeCount: undefined,
      integration: undefined,
      commitCount: null,
    });

    expect(name).toContain("no branch");
    expect(name).toContain("no worktree");
    expect(name).not.toContain("worktree folder");
    expect(name).not.toContain("provisioning");
    expect(name).not.toContain("changed file");
    expect(name).not.toContain("Task commit");
    expect(name).not.toContain("Needs input");
  });
});
