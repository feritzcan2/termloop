// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Task, WorkflowConfiguration, WorkflowExecution } from "../src/renderer/model.js";
import {
  TaskWorkflowLaunchers,
  WorkflowEditorDialog,
  initialWorkflowSteps,
  moveWorkflowStep,
  nextStepId,
  workflowStepResultFileName,
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

const execution: WorkflowExecution = {
  id: "workflow-execution-1",
  projectId: "project-1",
  taskId: "task-1",
  workflowId: workflow.id,
  workflowGeneration: workflow.generation,
  workflowName: workflow.name,
  goal: "Build a reusable workflow system.",
  coordinatorSessionId: "coordinator-1",
  currentStepIndex: 2,
  reviewCycle: 1,
  maxReviewCycles: workflow.maxReviewCycles,
  phase: "awaitingHelper",
  status: "running",
  steps: workflow.steps,
  participants: [
    { stepId: "discuss", sessionId: "claude-session-1" },
    { stepId: "review", sessionId: "claude-session-1" },
  ],
  activeReviewStepIds: ["review"],
  stepResults: [
    {
      stepId: "discuss",
      reviewCycle: 1,
      outcome: "completed",
      summary: "Use a Core-owned linear workflow and persist bounded step summaries.",
      completedAtEpochMs: 2,
    },
    {
      stepId: "implement",
      reviewCycle: 1,
      outcome: "completed",
      summary: "Implemented the workflow state machine and verified focused tests.",
      completedAtEpochMs: 2,
    },
  ],
  startedAtEpochMs: 1,
  updatedAtEpochMs: 2,
};

describe("Task workflow editor", () => {
  it("shows a compact node canvas with a parallel review join", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowEditorDialog, {
      projectId: "project-1",
      stateRevision: 1,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      close: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Workflow nodes"');
    expect(markup).toContain('aria-label="Workflow canvas"');
    expect(markup).toContain("2 parallel reviewers");
    expect(markup).toContain("Wait for all");
    expect(markup).toContain("Core combines review outcomes");
  });

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

  it("names compact result artifacts by step role and disambiguates multiple reviews", () => {
    const steps = initialWorkflowSteps();
    expect(workflowStepResultFileName(steps[0]!, steps)).toBe("decisions.md");
    expect(workflowStepResultFileName(steps[1]!, steps)).toBe("implementation.md");
    expect(workflowStepResultFileName(steps[2]!, steps)).toBe("review-claude.md");
    expect(workflowStepResultFileName(steps[3]!, steps)).toBe("review-codex.md");
    expect(workflowStepResultFileName(steps[4]!, steps)).toBe("fixes.md");
  });

  it("renders a saved workflow as one Task launcher with an editable workflow entry", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      projectId: task.project_id,
      task,
      configurations: [workflow],
      executions: [],
      stateRevision: 4,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: () => undefined,
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
      executions: [],
      stateRevision: 4,
      agentCapabilities: [fullAgentCapability("codex", { available: false })],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: () => undefined,
    }));

    expect(markup).toContain('aria-label="Run workflow Discuss, build, review in Add simple workflows"');
    expect(markup).not.toContain("disabled");
  });

  it("shows the Core-owned current step and prevents a second workflow on the same Task", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      projectId: task.project_id,
      task,
      configurations: [workflow],
      executions: [execution],
      stateRevision: 5,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: (sessionId: string) => sessionId === "coordinator-1"
        ? { agentLabel: "Codex", stateLabel: "Working", tone: "working" as const }
        : { agentLabel: "Claude", stateLabel: "Idle", tone: "quiet" as const },
    }));

    expect(markup).toContain('aria-label="Hide Discuss, build, review workflow steps"');
    expect(markup).toContain("3/3");
    expect(markup).toContain('aria-label="Discuss, build, review workflow progress"');
    expect(markup).toContain('aria-label="Open decisions.md"');
    expect(markup).toContain('aria-label="Open implementation.md"');
    expect(markup).not.toContain("Use a Core-owned linear workflow and persist bounded step summaries.");
    expect(markup).not.toContain("Implemented the workflow state machine and verified focused tests.");
    expect(markup).toContain('data-workflow-session-id="coordinator-1"');
    expect(markup).toContain('data-workflow-session-id="claude-session-1"');
    expect(markup).toContain('aria-label="Open Codex — Working"');
    expect(markup).toContain('aria-label="Open Claude — Idle"');
    expect(markup.match(/data-workflow-session-id="coordinator-1"/gu)).toHaveLength(2);
    expect(markup).toContain(">same coordinator</em>");
    expect(markup).toContain(">same session</em>");
    expect(markup).toContain(">Details</button>");
    expect(markup).toContain("Finish or stop Discuss, build, review first");
    expect(markup).toContain("disabled");
  });

  it("opens a sidebar result artifact in a focused reader", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskWorkflowLaunchers, {
      projectId: task.project_id,
      task,
      configurations: [workflow],
      executions: [execution],
      stateRevision: 5,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: () => undefined,
    })));

    expect(container.textContent).not.toContain("Use a Core-owned linear workflow and persist bounded step summaries.");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open decisions.md"]')!.click());
    const reader = container.querySelector<HTMLElement>('[aria-labelledby="workflow-result-title"]');
    expect(reader?.textContent).toContain("decisions.md");
    expect(reader?.textContent).toContain("Use a Core-owned linear workflow and persist bounded step summaries.");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps active progress visible when Task launchers are temporarily unavailable", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      projectId: task.project_id,
      task,
      configurations: [workflow],
      executions: [execution],
      stateRevision: 5,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      launchable: false,
      showLaunchers: false,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: () => undefined,
    }));

    expect(markup).toContain('aria-label="Discuss, build, review workflow progress"');
    expect(markup).toContain('aria-label="Open implementation.md"');
    expect(markup).not.toContain("Implemented the workflow state machine and verified focused tests.");
    expect(markup).not.toContain('aria-label="Run workflow Discuss, build, review in Add simple workflows"');
    expect(markup).not.toContain('aria-label="Add workflow"');
  });
});
