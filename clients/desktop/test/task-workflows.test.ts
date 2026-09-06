import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowConfiguration } from "../src/renderer/model.js";
import {
  TaskWorkflowLaunchers,
  initialWorkflowSteps,
  moveWorkflowStep,
  nextStepId,
} from "../src/renderer/ui/TaskWorkflows.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

const task: Task = {
  id: "task-1",
  project_id: "project-1",
  title: "Add simple workflows",
  brief: null,
  jira_url: null,
  archived_at_epoch_ms: null,
  status: "open",
  branch: { repository_root: "/repo", name: "task/workflows" },
  worktree: { path: "/repo/.worktrees/workflows" },
  worktree_generation: 1,
  worktree_health: {
    observation_sequence: 1,
    observed_at_epoch_ms: 1,
    path_state: "present",
    registration_state: "matching",
    head_state: "matching",
    launch_ready: true,
    checked_out_branch: "task/workflows",
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
  rank: 0,
  created_at_epoch_ms: 1,
  updated_at_epoch_ms: 1,
};

const workflow: WorkflowConfiguration = {
  id: "workflow-1",
  projectId: "project-1",
  name: "Discuss, build, review",
  coordinatorAgentId: "codex",
  model: "default",
  permission: "acceptEdits",
  reasoning: "default",
  maxReviewCycles: 2,
  steps: [
    { id: "discuss", kind: "discuss", title: "Discuss", instructions: "Challenge the approach.", agentId: "claude", reuseStepId: null },
    { id: "implement", kind: "implement", title: "Implement", instructions: "Build it.", agentId: null, reuseStepId: null },
    { id: "review", kind: "review", title: "Review", instructions: "Review the diff.", agentId: "claude", reuseStepId: "discuss" },
  ],
  generation: 1,
  updatedAtEpochMs: 1,
};

describe("Task workflow editor", () => {
  it("creates stable unique step ids inside the bounded linear workflow", () => {
    expect(nextStepId("discuss", [{ id: "discuss-1" }, { id: "review-1" }])).toBe("discuss-2");
    expect(nextStepId("review", [{ id: "review-1" }, { id: "review-2" }])).toBe("review-3");
  });

  it("starts with the Codex and Claude discussion, reused Claude review, fresh Codex review, and coordinator fix", () => {
    expect(initialWorkflowSteps()).toEqual([
      expect.objectContaining({ id: "discuss-claude", kind: "discuss", agentId: "claude", reuseStepId: null }),
      expect.objectContaining({ id: "implement", kind: "implement", agentId: null, reuseStepId: null }),
      expect.objectContaining({ id: "review-claude", kind: "review", agentId: "claude", reuseStepId: "discuss-claude" }),
      expect.objectContaining({ id: "review-codex", kind: "review", agentId: "codex", reuseStepId: null }),
      expect.objectContaining({ id: "fix", kind: "fix", agentId: null, reuseStepId: null }),
    ]);
  });

  it("reorders cards only inside the same movable phase", () => {
    const steps = initialWorkflowSteps();
    const reordered = moveWorkflowStep(steps, "review-codex", "review-claude");
    expect(reordered.map((step) => step.id)).toEqual([
      "discuss-claude", "implement", "review-codex", "review-claude", "fix",
    ]);
    expect(moveWorkflowStep(steps, "review-codex", "implement")).toBe(steps);
    expect(moveWorkflowStep(steps, "implement", "review-claude")).toBe(steps);
  });

  it("renders a saved workflow as one Task launcher with an editable workflow entry", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      projectId: task.project_id,
      task,
      configurations: [workflow],
      stateRevision: 4,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      launchable: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      launch: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Run workflow Discuss, build, review in Add simple workflows"');
    expect(markup).toContain('title="Discuss → Implement → Review"');
    expect(markup).toContain('aria-label="Edit workflow Discuss, build, review"');
    expect(markup).toContain('aria-label="Add workflow"');
  });

  it("keeps saved workflows launchable while capability discovery refreshes", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      projectId: task.project_id,
      task,
      configurations: [workflow],
      stateRevision: 4,
      agentCapabilities: [fullAgentCapability("codex", { available: false })],
      launchable: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      launch: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Run workflow Discuss, build, review in Add simple workflows"');
    expect(markup).not.toContain("disabled");
  });
});
