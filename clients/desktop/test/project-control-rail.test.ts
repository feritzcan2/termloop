import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task } from "../src/renderer/model.js";
import { ProjectControlRail } from "../src/renderer/ui/ProjectControlRail.js";

function readyTask(): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Make project status obvious",
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
  };
}

describe("Project Control rail", () => {
  it("shows one recommendation and a compact status summary without repeating Task cards", () => {
    const markup = renderToStaticMarkup(createElement(ProjectControlRail, {
      tasks: [readyTask()],
      gitHostProjections: [],
      branchCommitSummaries: [],
      sessionsById: new Map(),
      statusesById: new Map(),
      agentCapabilities: [],
      disabled: false,
      openTask: () => {},
      prepareWorkspace: () => {},
      selectSession: () => {},
      openChanges: () => {},
      setTaskClosed: async () => {},
      launchTaskAgent: async () => undefined,
    }));

    expect(markup).toContain("1 task needs you");
    expect(markup).toContain("Do this next");
    expect(markup).toContain("Start work");
    expect(markup).toContain("Project status");
    expect(markup).toContain("Make project status obvious");
    expect(markup).not.toContain("pc-task");
    expect(markup).not.toContain("pc-facts");
    expect(markup).not.toContain("Action Inbox");
    expect(markup).not.toContain("Current facts");
  });
});
