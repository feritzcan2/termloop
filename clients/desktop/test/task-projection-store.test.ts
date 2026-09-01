import { describe, expect, it } from "vitest";
import type { BranchCommitSummary, GitHostProjection, Task } from "../src/renderer/model.js";
import { ProjectionStore } from "../src/renderer/state/projection-store.js";

function task(id: string, sequence: number): Task {
  return {
    id,
    project_id: "project",
    title: id,
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: null,
    status: "open",
    branch: null,
    worktree: { path: `/tmp/${id}` },
    rank: id === "one" ? 0 : 1,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
    worktree_generation: 1,
    worktree_health: {
      observation_sequence: sequence,
      observed_at_epoch_ms: sequence,
      path_state: "present",
      registration_state: "matching",
      head_state: "matching",
      launch_ready: true,
      checked_out_branch: "feature",
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
  };
}

function gitHost(taskId: string, generation: number): GitHostProjection {
  return {
    task_id: taskId,
    branch_name: "feature",
    repository_provider: "github",
    repository_host: "github.com",
    repository_owner: "acme",
    repository_project: null,
    repository_name: "widget",
    quality: "matches",
    freshness: "fresh",
    reason: null,
    matches: [],
    truncated: false,
    candidate_truncated: false,
    freshness_generation: generation,
    last_success_observed_at_epoch_ms: generation,
    last_attempt_observed_at_epoch_ms: generation,
  };
}

function pullRequest(number: number): GitHostProjection["matches"][number] {
  return {
    provider: "github",
    host: "github.com",
    repository_owner: "acme",
    repository_project: null,
    repository_name: "widget",
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widget/pull/${number}`,
    state: "open",
    base_branch: "main",
    head_branch: `feature-${number}`,
    head_repository_owner: "acme",
    head_repository_project: null,
    head_repository_name: "widget",
    check_rollup: "passing",
    check_rollup_source: "githubStatusCheckRollup",
    review_signal: "approved",
    review_signal_source: "githubReviewDecision",
    merge_conflict: "noneDetected",
    merge_conflict_source: "githubMergeable",
    activity_at_epoch_ms: number,
    activity_at_source: "githubUpdatedAt",
  };
}

describe("scoped Task projection merge", () => {
  it("restores each Project snapshot immediately and ignores inactive refreshes", () => {
    const store = new ProjectionStore();
    const projectA = { ...task("one", 1), project_id: "project-a" };
    const projectB = { ...task("two", 1), project_id: "project-b" };

    store.activateProjectSnapshot("project-a");
    store.applySelectedProjectSnapshot("project-a", [projectA]);
    store.activateProjectSnapshot("project-b");
    expect(store.getSnapshot().tasks).toEqual([]);

    store.applySelectedProjectSnapshot("project-b", [projectB]);
    store.activateProjectSnapshot("project-a");
    expect(store.getSnapshot().tasks).toEqual([projectA]);

    const refreshedProjectB = { ...projectB, title: "fresh project B" };
    store.applySelectedProjectSnapshot("project-b", [refreshedProjectB]);
    expect(store.getSnapshot().tasks).toEqual([projectA]);

    store.activateProjectSnapshot("project-b");
    expect(store.getSnapshot().tasks).toEqual([refreshedProjectB]);
  });

  it("keeps the exact Playbook processing Task from the latest full snapshot", () => {
    const store = new ProjectionStore();
    const playbookRuntime = {
      activePipelineName: "Delivery",
      processingTaskId: "one",
      steps: [{ milestoneId: "code", routineId: "routine-code", waitingTaskIds: ["one"], progress: [], nextAttemptAtEpochMs: null }],
      doneTaskIds: [],
      stateRevision: 3,
    };
    store.applySnapshot([], [task("one", 1)], [], [], [], [], undefined, [], [], 0, "one", null, playbookRuntime);

    expect(store.getSnapshot().processingTaskId).toBe("one");
    expect(store.getSnapshot().playbookRuntime).toBe(playbookRuntime);
    store.setMessage(undefined);
    expect(store.getSnapshot().processingTaskId).toBe("one");
    expect(store.getSnapshot().playbookRuntime).toBe(playbookRuntime);
  });

  it("patches only changed branch commit summaries and preserves equal identities", () => {
    const store = new ProjectionStore();
    const one = { task_id: "one", count: 1, base_ref: "refs/remotes/origin/main", not_in_base: { count: 1, base_ref: "refs/remotes/origin/main", freshness: "fresh", reason: null }, freshness: "fresh", reason: null } satisfies BranchCommitSummary;
    const two = { task_id: "two", count: 2, base_ref: "refs/remotes/origin/main", not_in_base: { count: 2, base_ref: "refs/remotes/origin/main", freshness: "fresh", reason: null }, freshness: "fresh", reason: null } satisfies BranchCommitSummary;
    store.applySnapshot([], [], [], [], [], [one, two]);
    let emissions = 0;
    store.subscribe(() => { emissions += 1; });

    store.applyBranchCommitPatch(["one", "two"], [{ ...one, count: 3 }, { ...two }]);
    expect(emissions).toBe(1);
    expect(store.getSnapshot().branchCommitSummaries[0]).not.toBe(one);
    expect(store.getSnapshot().branchCommitSummaries[1]).toBe(two);

    store.applyBranchCommitPatch(["one"], [{ ...one, count: 3 }]);
    expect(emissions).toBe(1);

    store.applyBranchCommitPatch(["one"], [{ ...one, count: 3, not_in_base: { ...one.not_in_base, count: 0 } }]);
    expect(emissions).toBe(2);
  });

  it("retains unrelated identity and emits nothing for an unchanged observation", () => {
    const store = new ProjectionStore();
    const one = task("one", 1);
    const two = task("two", 1);
    store.applySnapshot([], [one, two], [], []);
    let emissions = 0;
    store.subscribe(() => { emissions += 1; });

    store.applyTaskPatch(["one"], [task("one", 1)]);
    expect(emissions).toBe(0);
    expect(store.getSnapshot().tasks[0]).toBe(one);
    expect(store.getSnapshot().tasks[1]).toBe(two);

    store.applyTaskPatch(["one"], [task("one", 2)]);
    expect(emissions).toBe(1);
    expect(store.getSnapshot().tasks[0]).not.toBe(one);
    expect(store.getSnapshot().tasks[1]).toBe(two);
  });

  it("preserves equal Git-host object identity inside a changed batch", () => {
    const store = new ProjectionStore();
    const one = gitHost("one", 1);
    const two = gitHost("two", 1);
    store.applySnapshot([], [], [], [], [one, two]);
    let emissions = 0;
    store.subscribe(() => { emissions += 1; });

    store.applyGitHostPatch(["one", "two"], [gitHost("one", 2), gitHost("two", 1)]);
    expect(emissions).toBe(1);
    expect(store.getSnapshot().gitHostProjections[0]).not.toBe(one);
    expect(store.getSnapshot().gitHostProjections[1]).toBe(two);
  });

  it("does not let a late older Git-host response replace a newer wave", () => {
    const store = new ProjectionStore();
    const newer = gitHost("one", 2);
    store.applySnapshot([], [], [], [], [newer]);
    let emissions = 0;
    store.subscribe(() => { emissions += 1; });

    store.applyGitHostPatch(["one"], [gitHost("one", 1)]);
    expect(emissions).toBe(0);
    expect(store.getSnapshot().gitHostProjections[0]).toBe(newer);
  });

  it("does not let an equal-generation partial response replace a complete wave", () => {
    const store = new ProjectionStore();
    const complete = { ...gitHost("one", 2), matches: [pullRequest(1), pullRequest(2)] };
    store.applySnapshot([], [], [], [], [complete]);
    let emissions = 0;
    store.subscribe(() => { emissions += 1; });

    store.applyGitHostPatch(
      ["one"],
      [{ ...gitHost("one", 2), matches: [pullRequest(1)] }],
    );
    expect(emissions).toBe(0);
    expect(store.getSnapshot().gitHostProjections[0]).toBe(complete);
  });

  it("keeps errors in the bounded log when a fresh snapshot clears the current message", () => {
    const store = new ProjectionStore();
    store.setMessage("That Session is no longer running.");
    store.applySnapshot([], [], [], []);
    expect(store.getSnapshot().message).toBeUndefined();
    expect(store.getSnapshot().errorLog).toMatchObject([
      { id: 1, message: "That Session is no longer running." },
    ]);
  });

  it("keeps only the latest 50 errors and lets the user clear them", () => {
    const store = new ProjectionStore();
    for (let index = 0; index < 55; index += 1) store.setMessage(`failure-${index}`);

    expect(store.getSnapshot().errorLog).toHaveLength(50);
    expect(store.getSnapshot().errorLog[0]?.message).toBe("failure-5");
    expect(store.getSnapshot().errorLog[49]?.message).toBe("failure-54");

    store.clearErrorLog();
    expect(store.getSnapshot().errorLog).toEqual([]);
  });
});
