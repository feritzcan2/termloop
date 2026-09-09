// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowConfigurationCreateParams, WorkflowConfigurationUpdateParams } from "@termloop/contract/current";
import type { Task, WorkflowConfiguration, WorkflowExecution } from "../src/renderer/model.js";
import {
  TaskWorkflowLaunchers,
  WorkflowEditorPanel,
  initialWorkflowSteps,
  moveWorkflowStep,
  nextStepId,
  workflowStepResultFileName,
} from "../src/renderer/ui/TaskWorkflows.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";
import { removeWorkflowStep, type WorkflowEditorDraft } from "../src/renderer/ui/WorkflowEditorPanel.js";
import { workflowPhaseLabel, workflowStatusLabel, workflowSummary } from "../src/renderer/ui/workflow-presentation.js";

const edgeCaseHunter = {
  id: "builtin.agent-profile.edge-case-hunter",
  name: "Edge Case Hunter",
  description: "Probe a behavior for boundary conditions, races, and failure-path gaps.",
  category: "Quality",
  version: 2,
  permission: "plan" as const,
  read_only: true,
  user_invocable: true,
  agent_ids: ["claude", "codex"],
  source: "builtIn" as const,
  instructions: "Find the highest-risk edge cases.",
  favorite: true,
  default_agent_id: "codex" as const,
  default_model: "default",
  default_reasoning: "high" as const,
};

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
    { id: "discuss", kind: "discuss", title: "Discuss", instructions: "Challenge the approach.", agentId: "claude", reuseStepId: null, profileRef: null, model: "default", permission: "bypassPermissions", reasoning: "default" },
    { id: "implement", kind: "implement", title: "Implement", instructions: "Build it.", agentId: null, reuseStepId: null, profileRef: null, model: null, permission: null, reasoning: null },
    { id: "review", kind: "review", title: "Review", instructions: "Review the diff.", agentId: "claude", reuseStepId: "discuss", profileRef: null, model: null, permission: null, reasoning: null },
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
  completionOutcome: null,
  steps: workflow.steps,
  participants: [
    { stepId: "discuss", sessionId: "claude-session-1" },
    { stepId: "review", sessionId: "claude-session-1" },
  ],
  activeReviewStepIds: ["review"],
  pendingReviewStepIds: ["review"],
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
  it("shows a step flow with a parallel review join and explicit fix loop", () => {
    const markup = renderToStaticMarkup(createElement(WorkflowEditorPanel, {
      projectId: "project-1",
      configuration: { ...workflow, steps: initialWorkflowSteps() },
      stateRevision: 1,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      agentProfiles: [edgeCaseHunter],
      close: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Add workflow steps"');
    expect(markup).toContain('aria-label="Workflow flow"');
    expect(markup).toContain("2 parallel reviewers · run together");
    expect(markup).toContain("Collect all reviews");
    expect(markup).toContain("Fixes go back to all reviewers");
    expect(markup).toContain('class="stage-editor workflow-editor-stage"');
    expect(markup).not.toContain('role="dialog"');
  });

  it("defaults coordinator and fresh helper permissions to bypass and exposes every launch option", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(WorkflowEditorPanel, {
      projectId: "project-1",
      stateRevision: 1,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      agentProfiles: [edgeCaseHunter],
      close: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    })));

    await startNewTemplate(container);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Step Model"]')?.value).toBe("default");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Step Permission"]')?.value).toBe("bypassPermissions");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Step Thinking"]')?.value).toBe("default");
    await act(async () => container.querySelector<HTMLButtonElement>(".workflow-lead-card")!.click());
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Coordinator Model"]')?.value).toBe("default");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Coordinator Permission"]')?.value).toBe("bypassPermissions");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Coordinator Thinking"]')?.value).toBe("default");
    expect(container.querySelector('[aria-label="Step Model"]')).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("applies a saved Agent template and its launch defaults to an independent reviewer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const save = vi.fn(async (_params: WorkflowConfigurationCreateParams | WorkflowConfigurationUpdateParams) => workflow);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(WorkflowEditorPanel, {
      projectId: "project-1",
      stateRevision: 1,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      agentProfiles: [edgeCaseHunter],
      close: vi.fn(),
      save,
      remove: vi.fn(),
    })));

    await startNewTemplate(container);
    const review = [...container.querySelectorAll<HTMLButtonElement>(".workflow-step-select")]
      .find((button) => button.textContent?.includes("Independent second review"));
    await act(async () => review!.click());
    const template = container.querySelector<HTMLSelectElement>('[aria-label="Agent profile"]')!;
    await act(async () => {
      template.value = edgeCaseHunter.id;
      template.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("Edge Case Hunter");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Step Permission"]')?.value).toBe("plan");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Step Thinking"]')?.value).toBe("high");
    await act(async () => container.querySelector<HTMLButtonElement>(".stage-editor-actions .primary-button")!.click());
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.steps.find((step) => step.id === "review-codex")).toEqual(expect.objectContaining({
      agentId: "codex",
      profileRef: edgeCaseHunter.id,
      permission: "plan",
      reasoning: "high",
    }));

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
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

  it("renders only a compact Workflow button, not a template section or saved cards", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      task,
      configurations: [workflow],
      executions: [],
      agentProfiles: [edgeCaseHunter],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      edit: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: () => undefined,
    }));

    expect(markup).toContain('aria-label="Workflow" aria-haspopup="menu" aria-expanded="false"');
    expect(markup.match(/<button /gu)).toHaveLength(1);
    expect(markup).not.toContain(workflow.name);
    expect(markup).not.toContain("Workflow templates");
    expect(markup).not.toContain("saved template");
  });

  it("routes edit and create intents to the workspace stage owner", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const edit = vi.fn();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskWorkflowLaunchers, {
      task,
      configurations: [workflow],
      executions: [],
      agentProfiles: [edgeCaseHunter],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      edit,
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: () => undefined,
    })));

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Workflow"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit template Discuss, build, review"]')!.click());
    expect(edit).toHaveBeenLastCalledWith(workflow);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Workflow"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New workflow template"]')!.click());
    expect(edit).toHaveBeenLastCalledWith(undefined);
    expect(container.querySelector('[role="menu"]')).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps saved workflows launchable while capability discovery refreshes", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      task,
      configurations: [workflow],
      executions: [],
      agentProfiles: [edgeCaseHunter],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      edit: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: () => undefined,
    }));

    expect(markup).toContain('aria-label="Workflow"');
    expect(markup).not.toContain("disabled");
  });

  it("keeps the Core-owned current step visible alongside the compact Workflow button", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      task,
      configurations: [workflow],
      executions: [execution],
      agentProfiles: [edgeCaseHunter],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      edit: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: (sessionId: string) => sessionId === "coordinator-1"
        ? { agentLabel: "Codex", stateLabel: "Working", tone: "working" as const }
        : { agentLabel: "Claude", stateLabel: "Idle", tone: "quiet" as const },
    }));

    expect(markup).toContain('aria-label="Hide Discuss, build, review workflow steps"');
    expect(markup).toContain("Step 3 of 3 · Review");
    expect(markup).toContain('class="workflow-execution-state">Running');
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
    expect(markup).toContain('aria-label="Workflow"');
    expect(markup).not.toContain("workflow-saved-templates");
    expect(markup).not.toContain('aria-label="Run workflow');
  });

  it("keeps a project-sized template library behind the same single button", () => {
    const markup = renderToStaticMarkup(createElement(TaskWorkflowLaunchers, {
      task, configurations: Array.from({ length: 16 }, (_, index) => ({ ...workflow, id: `workflow-${index}` })),
      executions: [], agentProfiles: [], launchable: true, showLaunchers: true,
      overlayContainer: undefined, overlayVisibilityChanged: vi.fn(), edit: vi.fn(), launch: vi.fn(),
      cancel: vi.fn(), openSession: vi.fn(), sessionPresentation: () => undefined,
    }));
    expect(markup.match(/<button /gu)).toHaveLength(1);
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("saved templates");
  });

  it("opens a sidebar result artifact in a focused reader", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskWorkflowLaunchers, {
      task,
      configurations: [workflow],
      executions: [execution],
      agentProfiles: [edgeCaseHunter],
      launchable: true,
      showLaunchers: true,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      edit: vi.fn(),
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
      task,
      configurations: [workflow],
      executions: [execution],
      agentProfiles: [edgeCaseHunter],
      launchable: false,
      showLaunchers: false,
      overlayContainer: undefined,
      overlayVisibilityChanged: vi.fn(),
      edit: vi.fn(),
      launch: vi.fn(),
      cancel: vi.fn(),
      openSession: vi.fn(),
      sessionPresentation: () => undefined,
    }));

    expect(markup).toContain('aria-label="Discuss, build, review workflow progress"');
    expect(markup).toContain('aria-label="Open implementation.md"');
    expect(markup).not.toContain("Implemented the workflow state machine and verified focused tests.");
    expect(markup).not.toContain('aria-label="Run workflow Discuss, build, review in Add simple workflows"');
    expect(markup).not.toContain('aria-label="New workflow template"');
  });
});

async function launcherFixture(overrides: Partial<ComponentProps<typeof TaskWorkflowLaunchers>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props: ComponentProps<typeof TaskWorkflowLaunchers> = {
    task, configurations: [workflow], executions: [], agentProfiles: [], launchable: true,
    showLaunchers: true, overlayContainer: undefined, overlayVisibilityChanged: vi.fn(),
    edit: vi.fn(), launch: vi.fn(async () => undefined), cancel: vi.fn(),
    openSession: vi.fn(), sessionPresentation: () => undefined, ...overrides,
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const render = async () => { await act(async () => root.render(createElement(TaskWorkflowLaunchers, props))); };
  await render();
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Workflow"]')!;
  return { container, props, trigger, render,
    async open() { await act(async () => trigger.click()); },
    async dispose() {
      await act(async () => root.unmount()); container.remove();
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

describe("Compact workflow menu", () => {
  it("places execution status in its own row after all Start controls", async () => {
    const f = await launcherFixture({
      executions: [execution],
      renderLaunchers: (workflowButton) => createElement("div", { className: "task-launch" },
        createElement("button", {}, "Terminal"), workflowButton, createElement("button", {}, "Run dev server")),
    });
    try {
      const start = f.container.querySelector(".task-launch")!;
      const row = f.container.querySelector(".workflow-execution-row")!;
      expect(start.nextElementSibling).toBe(row);
      expect(start.querySelector(".workflow-add")).not.toBeNull();
      expect(start.querySelector(".workflow-execution-toggle")).toBeNull();
      expect(row.querySelector(".workflow-execution-state")?.textContent).toBe("Running");
      expect(row.querySelector(".workflow-execution-detail")?.textContent).toBe("Step 3 of 3 · Review");
      expect(row.querySelector(".workflow-sidebar-progress")).not.toBeNull();
      const toggle = row.querySelector<HTMLButtonElement>(".workflow-execution-toggle")!;
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(row.querySelector(".workflow-sidebar-progress")).toBeNull();
      expect(row.querySelector(".workflow-execution-state")?.textContent).toBe("Running");
      await act(async () => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    } finally { await f.dispose(); }
  });

  it.each([
    ["approved", "All reviewers approved", false],
    ["completed", "No final review approval recorded", false],
    ["changesRequested", "Changes requested", true],
    ["reviewLimitReached", "Review limit reached", true],
  ] as const)("distinguishes a finished %s outcome without opening the steps", async (completionOutcome, summary, needsAttention) => {
    const f = await launcherFixture({ executions: [{ ...execution, status: "completed", phase: "completed", completionOutcome }] });
    try {
      const row = f.container.querySelector(".workflow-execution-row")!;
      const start = f.container.querySelector(".task-launch")!;
      expect(start.nextElementSibling).toBe(row);
      expect(start.querySelector(".workflow-add")).not.toBeNull();
      expect(row.closest(".task-launch")).toBeNull();
      expect(row.querySelector(".workflow-execution-state")?.textContent).toBe("Completed");
      expect(row.querySelector(".workflow-execution-detail")?.textContent).toBe(summary);
      expect(row.classList.contains("needs-attention")).toBe(needsAttention);
      expect(row.querySelector(".workflow-execution-symbol")?.textContent).toBe(needsAttention ? "!" : "✓");
      expect(row.querySelector(".workflow-sidebar-progress")).toBeNull();
      expect(row.textContent).not.toContain("Step 3 of 3");
    } finally { await f.dispose(); }
  });

  it("updates a collapsed running row to paused and then completed from the execution projection", async () => {
    const f = await launcherFixture({ executions: [execution] });
    try {
      await act(async () => f.container.querySelector<HTMLButtonElement>(".workflow-execution-toggle")!.click());
      f.props.executions = [{ ...execution, status: "paused" }];
      await f.render();
      expect(f.container.querySelector(".workflow-execution-state")?.textContent).toBe("Paused");
      expect(f.container.querySelector(".workflow-sidebar-progress")).toBeNull();
      f.props.executions = [{ ...execution, status: "completed", phase: "completed", completionOutcome: "approved" }];
      await f.render();
      expect(f.container.querySelector(".workflow-execution-state")?.textContent).toBe("Completed");
      expect(f.container.querySelector(".workflow-execution-detail")?.textContent).toBe("All reviewers approved");
    } finally { await f.dispose(); }
  });

  it("keeps progress independent when launch controls are unavailable", async () => {
    const f = await launcherFixture({ executions: [execution], showLaunchers: false, launchable: false });
    try {
      expect(f.container.querySelector(".task-launch")).toBeNull();
      expect(f.container.querySelector(".workflow-execution-row")).not.toBeNull();
    } finally { await f.dispose(); }
  });

  it("opens on demand and runs the selected workflow with the Task description", async () => {
    const f = await launcherFixture({ task: { ...task, brief: "Implement and test the screen." } });
    try {
      expect(f.container.querySelector('[role="menu"]')).toBeNull();
      await f.open();
      expect(f.trigger.getAttribute("aria-expanded")).toBe("true");
      expect(f.props.overlayVisibilityChanged).toHaveBeenLastCalledWith(true);
      const run = f.container.querySelector<HTMLButtonElement>('[aria-label="Run workflow Discuss, build, review in Add simple workflows"]')!;
      expect(run.disabled).toBe(false);
      expect(document.activeElement).toBe(run);
      await act(async () => run.click());
      expect(f.container.querySelector('[role="menu"]')).toBeNull();
      expect(f.container.querySelector<HTMLTextAreaElement>("#workflow-run-goal")?.value).toBe("Implement and test the screen.");
      await act(async () => f.container.querySelector<HTMLButtonElement>(".workflow-run-dialog .primary-button")!.click());
      expect(f.props.launch).toHaveBeenCalledExactlyOnceWith(task.id, workflow.id, "Implement and test the screen.");
    } finally { await f.dispose(); }
  });

  it("opens the template editor directly when there are no saved templates", async () => {
    const f = await launcherFixture({ configurations: [] });
    try {
      await f.open();
      expect(f.props.edit).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(f.container.querySelector('[role="menu"]')).toBeNull();
    } finally { await f.dispose(); }
  });

  it.each([false, true])("blocks launching but preserves editing when worktree/execution is unavailable (%s)", async (active) => {
    const f = await launcherFixture({ launchable: active, executions: active ? [execution] : [] });
    try {
      await f.open();
      const run = f.container.querySelector<HTMLButtonElement>('[aria-label^="Run workflow"]')!;
      expect(run.disabled).toBe(true);
      expect(f.container.querySelector(".workflow-menu-notice")?.textContent).toContain(active ? "Finish or stop" : "worktree must be ready");
      const edit = f.container.querySelector<HTMLButtonElement>('[aria-label="Edit template Discuss, build, review"]')!;
      expect(edit.disabled).toBe(false);
      expect(document.activeElement).toBe(edit);
      await act(async () => run.click());
      expect(f.props.launch).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it("supports keyboard navigation, Escape, outside dismissal, and focus restoration", async () => {
    const f = await launcherFixture();
    try {
      await f.open();
      const key = async (value: string) => { await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))); };
      await key("ArrowDown");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit template Discuss, build, review");
      await key("End");
      expect(document.activeElement?.getAttribute("aria-label")).toBe("New workflow template");
      await key("Escape");
      expect(f.container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(f.trigger);
      expect(f.props.overlayVisibilityChanged).toHaveBeenLastCalledWith(false);
      await f.open();
      await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Close workflow menu"]')!.click());
      expect(f.container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(f.trigger);
    } finally { await f.dispose(); }
  });

  it("keeps the template limit inside the menu, without disabling existing workflows", async () => {
    const f = await launcherFixture({ configurations: Array.from({ length: 16 }, (_, i) => ({ ...workflow, id: `workflow-${i}` })) });
    try {
      await f.open();
      expect(f.container.querySelectorAll('[aria-label^="Run workflow"]')).toHaveLength(16);
      const create = f.container.querySelector<HTMLButtonElement>('[aria-label="New workflow template"]')!;
      expect(create.disabled).toBe(true);
      expect(create.title).toContain("limit of 16 templates");
      expect(f.container.querySelector<HTMLButtonElement>('[aria-label^="Run workflow"]')!.disabled).toBe(false);
    } finally { await f.dispose(); }
  });

  it("keeps keyboard focus usable if a template disappears, and closes when launchers are hidden", async () => {
    const f = await launcherFixture();
    try {
      await f.open();
      f.props.configurations = [];
      await f.render();
      expect(document.activeElement?.getAttribute("aria-label")).toBe("New workflow template");
      expect(f.container.querySelector('[aria-label^="Run workflow"]')).toBeNull();
      f.props.showLaunchers = false;
      await f.render();
      expect(f.container.querySelector('[role="menu"]')).toBeNull();
      expect(f.props.overlayVisibilityChanged).toHaveBeenLastCalledWith(false);
    } finally { await f.dispose(); }
  });
});

async function editorFixture(overrides: Partial<ComponentProps<typeof WorkflowEditorPanel>> = {}, customize = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = {
    projectId: "project-1", stateRevision: 1,
    agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
    agentProfiles: [edgeCaseHunter], close: vi.fn(), save: vi.fn(async () => workflow), remove: vi.fn(),
    ...overrides,
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(WorkflowEditorPanel, props)));
  if (customize && container.querySelector('[aria-label="Workflow starting points"]')) await startNewTemplate(container);
  return { container, root, props, async dispose() {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  } };
}

describe("Workflow lead card", () => {
  it("keeps the lead inside the workflow but outside the numbered, draggable steps", async () => {
    const f = await editorFixture({ configuration: workflow });
    try {
      const lead = f.container.querySelector<HTMLButtonElement>(".workflow-lead-card")!;
      expect(lead.closest(".workflow-pipeline")).not.toBeNull();
      expect(lead.closest(".workflow-canvas")).toBeNull();
      expect(lead.querySelector(".workflow-step-number,.workflow-drag-handle")).toBeNull();
      expect(f.container.querySelector(".workflow-builder-top")?.textContent).toBe("Template name");
      expect(f.container.textContent).not.toContain("Advanced lead agent settings");
      expect(f.container.querySelector("#workflow-pipeline-title")?.textContent).toBe("Workflow 3/8 steps");
      await act(async () => lead.click());
      expect(lead.getAttribute("aria-pressed")).toBe("true");
      expect(f.container.querySelector(".workflow-step-card.selected")).toBeNull();
      const inspector = f.container.querySelector(`#${lead.getAttribute("aria-controls")}`)!;
      expect(inspector.getAttribute("aria-label")).toBe("Workflow lead agent settings");
      expect(inspector.querySelector("#workflow-coordinator")).not.toBeNull();
      expect(inspector.textContent).toContain("It is not an extra step");
      expect(inspector.querySelector('[aria-label^="Remove"]')).toBeNull();
      expect(rootButton(f.container, "Save changes").disabled).toBe(true);
      expect(f.props.save).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it("edits lead settings without overwriting helper settings or adding a step to the saved template", async () => {
    const save = vi.fn(async (_params: WorkflowConfigurationCreateParams | WorkflowConfigurationUpdateParams) => workflow);
    const f = await editorFixture({ configuration: workflow, save });
    try {
      await act(async () => f.container.querySelector<HTMLButtonElement>(".workflow-lead-card")!.click());
      await selectValue(f.container, "#workflow-coordinator", "claude");
      await selectValue(f.container, "#workflow-coordinator-model", "sonnet");
      await selectValue(f.container, "#workflow-coordinator-permission", "plan");
      await selectValue(f.container, "#workflow-coordinator-reasoning", "high");
      const lead = f.container.querySelector(".workflow-lead-card")!;
      expect(lead.textContent).toContain("Lead agent · Claude");
      expect(lead.textContent).toContain("sonnet · Plan only · High");
      await act(async () => f.container.querySelector<HTMLButtonElement>(".kind-implement .workflow-step-select")!.click());
      expect(f.container.querySelector(".workflow-owned-step")?.textContent).toContain("Uses workflow lead · Claude");
      expect(f.container.querySelector(".workflow-owned-step")?.textContent).toContain("sonnet · Plan only · High");
      expect(lead.getAttribute("aria-pressed")).toBe("false");
      await act(async () => rootButton(f.container, "Edit lead agent").click());
      expect(f.container.querySelector<HTMLSelectElement>("#workflow-coordinator-model")?.value).toBe("sonnet");
      await act(async () => rootButton(f.container, "Save changes").click());
      expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workflowId: workflow.id, coordinatorAgentId: "claude", model: "sonnet", permission: "plan", reasoning: "high", steps: workflow.steps }));
    } finally { await f.dispose(); }
  });

  it.each(["implement", "fix"])("links the %s inspector back to the single workflow lead", async (kind) => {
    const f = await editorFixture();
    try {
      const card = f.container.querySelector<HTMLButtonElement>(`.kind-${kind} .workflow-step-select`)!;
      expect(card.textContent).toContain("Uses workflow lead");
      await act(async () => card.click());
      await act(async () => rootButton(f.container, "Edit lead agent").click());
      expect(f.container.querySelector(".workflow-lead-card")?.getAttribute("aria-pressed")).toBe("true");
      expect(f.container.querySelectorAll("#workflow-coordinator")).toHaveLength(1);
      expect(f.container.querySelectorAll(".workflow-step-card")).toHaveLength(5);
    } finally { await f.dispose(); }
  });

  it("does not display or silently reinterpret an invalid saved lead identity", async () => {
    const invalidId = "tlc:36:eb49f1e9-2fa7-4490-8815-e3d79ae3653dcodex";
    const save = vi.fn(async (_params: WorkflowConfigurationCreateParams | WorkflowConfigurationUpdateParams) => workflow);
    const f = await editorFixture({ configuration: { ...workflow, coordinatorAgentId: invalidId as WorkflowConfiguration["coordinatorAgentId"] }, save });
    try {
      expect(f.container.textContent).not.toContain(invalidId);
      await setText(f.container, "#workflow-name", "Repaired workflow");
      await act(async () => rootButton(f.container, "Save changes").click());
      expect(save).not.toHaveBeenCalled();
      expect(f.container.querySelector<HTMLSelectElement>("#workflow-coordinator")?.selectedOptions[0]?.textContent).toBe("Unavailable agent — choose a lead");
      expect(f.container.textContent).toContain("Choose a supported lead agent");
      expect(f.container.textContent).not.toContain(invalidId);
      await selectValue(f.container, "#workflow-coordinator", "codex");
      await act(async () => rootButton(f.container, "Save changes").click());
      expect(save.mock.calls[0]?.[0].coordinatorAgentId).toBe("codex");
    } finally { await f.dispose(); }
  });

  it("returns to the incomplete step when saving from the lead inspector", async () => {
    const f = await editorFixture();
    try {
      await setText(f.container, "textarea", " ");
      await act(async () => f.container.querySelector<HTMLButtonElement>(".workflow-lead-card")!.click());
      await act(async () => rootButton(f.container, "Create template").click());
      expect(f.props.save).not.toHaveBeenCalled();
      expect(f.container.querySelector(".workflow-inspector-head")?.textContent).toContain("Step 1 · Discuss");
      expect(f.container.querySelector(".workflow-lead-card")?.getAttribute("aria-pressed")).toBe("false");
    } finally { await f.dispose(); }
  });
});

async function selectValue(container: Element, selector: string, value: string) {
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>(selector)!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("Workflow review regressions", () => {
  it("removes an optional fix and removes its orphan when the last reviewer is removed", () => {
    const steps = initialWorkflowSteps();
    expect(removeWorkflowStep(steps, "fix").map((step) => step.id)).not.toContain("fix");
    const oneReview = removeWorkflowStep(steps, "review-codex");
    expect(oneReview.map((step) => step.id)).toContain("fix");
    const noReviews = removeWorkflowStep(oneReview, "review-claude");
    expect(noReviews.map((step) => step.kind)).toEqual(["discuss", "implement"]);
    expect(removeWorkflowStep(steps, "implement")).toEqual(steps);
  });

  it("exposes removal for the fix step but not the required implementation", async () => {
    const f = await editorFixture();
    try {
      const select = (title: string) => [...f.container.querySelectorAll<HTMLButtonElement>(".workflow-step-select")].find((button) => button.textContent?.includes(title))!;
      await act(async () => select("Fix review findings").click());
      await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Remove Fix review findings"]')!.click());
      expect(f.container.querySelector(".workflow-step-card.kind-fix")).toBeNull();
      await act(async () => select("Implement").click());
      expect(f.container.querySelector('[aria-label="Remove Implement"]')).toBeNull();
    } finally { await f.dispose(); }
  });

  it("confirms Escape/close, preserves the draft through navigation, and clears it only on discard", async () => {
    let draft: WorkflowEditorDraft | undefined;
    const f = await editorFixture({ draftChanged: (value) => { draft = value; } });
    try {
      await act(async () => f.container.querySelector<HTMLButtonElement>(".workflow-palette-node.kind-discuss")!.click());
      expect(draft?.value.steps).toHaveLength(6);
      await act(async () => f.container.querySelector(".workflow-editor-stage")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(f.props.close).not.toHaveBeenCalled();
      expect(f.container.textContent).toContain("Discard your unsaved changes?");
      await act(async () => rootButton(f.container, "Keep editing").click());
      await act(async () => f.root.render(null));
      await act(async () => f.root.render(createElement(WorkflowEditorPanel, { ...f.props, initialDraft: draft })));
      expect(f.container.querySelectorAll(".workflow-step-card")).toHaveLength(6);
      await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Close workflow editor"]')!.click());
      expect(f.props.close).not.toHaveBeenCalled();
      await act(async () => rootButton(f.container, "Discard changes").click());
      expect(f.props.close).toHaveBeenCalledOnce();
      expect(draft).toBeUndefined();
    } finally { await f.dispose(); }
  });

  it("keeps a rejected save editable and blocks close while a save is pending", async () => {
    let resolve!: (result: WorkflowConfiguration) => void;
    const save = vi.fn(() => new Promise<WorkflowConfiguration>((done) => { resolve = done; }));
    const f = await editorFixture({ save });
    try {
      await act(async () => rootButton(f.container, "Create template").click());
      expect(f.container.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
      await act(async () => f.container.querySelector(".workflow-editor-stage")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(f.props.close).not.toHaveBeenCalled();
      await act(async () => resolve(workflow));
      expect(f.props.close).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
    const rejected = await editorFixture({ save: vi.fn(async () => { throw new Error("Save unavailable"); }) });
    try {
      await act(async () => rootButton(rejected.container, "Create template").click());
      expect(rejected.container.textContent).toContain("Save unavailable");
      expect(rejected.container.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(false);
      expect(rejected.props.close).not.toHaveBeenCalled();
    } finally { await rejected.dispose(); }
  });

  it("distinguishes final approval, remaining findings, and an unreviewed last fix", () => {
    for (const [completionOutcome, label] of [["approved", "Approved"], ["changesRequested", "Changes requested"], ["reviewLimitReached", "Review limit reached"], ["completed", "Completed"]] as const) {
      expect(workflowStatusLabel({ ...execution, status: "completed", completionOutcome })).toBe(label);
    }
    expect(workflowPhaseLabel({ ...execution, status: "completed", completionOutcome: "reviewLimitReached" }, undefined)).toContain("last fixes have not been reviewed again");
    expect(workflowPhaseLabel({ ...execution, steps: initialWorkflowSteps(), pendingReviewStepIds: ["review-codex"] }, workflow.steps[2])).toBe("Waiting for 1 of 2 reviewers");
    expect(workflowSummary({ ...workflow, steps: initialWorkflowSteps() })).toContain("2 reviewers in parallel");
  });
});

function rootButton(container: Element, text: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text)!;
}

async function setText(container: Element, selector: string, value: string) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function startNewTemplate(container: Element) {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Discuss, build & review"]')!.click());
  await setText(container, "#workflow-name", "My workflow");
}

describe("Workflow template creation UX", () => {
  it("starts with a choice, never a prefilled existing-looking editor or an implicit save", async () => {
    const f = await editorFixture({}, false);
    try {
      expect(f.container.textContent).toContain("Create a workflow template");
      expect(f.container.textContent).toContain("These are examples, not your saved templates");
      expect(f.container.querySelectorAll(".workflow-starter-card")).toHaveLength(3);
      expect(f.container.querySelector("#workflow-name")).toBeNull();
      await act(async () => f.container.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true })));
      expect(f.props.save).not.toHaveBeenCalled();
      await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Close workflow editor"]')!.click());
      expect(f.props.close).toHaveBeenCalledOnce();
      expect(f.container.textContent).not.toContain("Discard your unsaved changes?");
    } finally { await f.dispose(); }
  });

  it.each([
    ["Start simple", ["implement"]],
    ["Build & review", ["implement", "review", "fix"]],
    ["Discuss, build & review", ["discuss", "implement", "review", "review", "fix"]],
  ])("creates a separately named project template from %s", async (label, kinds) => {
    const save = vi.fn(async (_params: WorkflowConfigurationCreateParams | WorkflowConfigurationUpdateParams) => workflow);
    const f = await editorFixture({ save }, false);
    try {
      await act(async () => f.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
      expect(f.container.querySelector<HTMLInputElement>("#workflow-name")?.value).toBe("");
      expect(f.container.querySelectorAll(".workflow-step-card")).toHaveLength(kinds.length);
      expect(f.container.textContent).toContain("Make this workflow yours");
      expect(f.container.textContent).not.toContain("Save changes");
      await act(async () => rootButton(f.container, "Create template").click());
      expect(save).not.toHaveBeenCalled();
      expect(document.activeElement?.id).toBe("workflow-name");
      expect(f.container.querySelector('[role="alert"]')?.textContent).toContain("Give this template a name");
      await setText(f.container, "#workflow-name", "  My new template  ");
      await act(async () => rootButton(f.container, "Create template").click());
      expect(save).toHaveBeenCalledOnce();
      const params = save.mock.calls[0]![0];
      expect(params).toEqual(expect.objectContaining({ projectId: "project-1", name: "My new template" }));
      expect(params).not.toHaveProperty("workflowId");
      expect(params.steps.map((step) => step.kind)).toEqual(kinds);
      expect(new Set(params.steps.map((step) => step.id)).size).toBe(params.steps.length);
      expect(f.props.close).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
  });

  it("edits the saved identity only and labels its action Save changes", async () => {
    const save = vi.fn(async (_params: WorkflowConfigurationCreateParams | WorkflowConfigurationUpdateParams) => workflow);
    const f = await editorFixture({ configuration: workflow, save });
    try {
      expect(f.container.textContent).toContain(`Edit “${workflow.name}”`);
      expect(f.container.querySelector(".workflow-starter")).toBeNull();
      expect(rootButton(f.container, "Save changes").disabled).toBe(true);
      await setText(f.container, "#workflow-name", "Updated template");
      await act(async () => rootButton(f.container, "Save changes").click());
      expect(save.mock.calls[0]![0]).toEqual(expect.objectContaining({ workflowId: workflow.id, name: "Updated template" }));
      expect(save.mock.calls[0]![0]).not.toHaveProperty("projectId");
    } finally { await f.dispose(); }
  });

  it("requires confirmation to replace customized steps and keeps the chosen name", async () => {
    const f = await editorFixture();
    try {
      await act(async () => rootButton(f.container, "Change starting point").click());
      expect(f.container.querySelectorAll(".workflow-step-card")).toHaveLength(5);
      await act(async () => rootButton(f.container, "Keep editing").click());
      expect(f.container.querySelectorAll(".workflow-step-card")).toHaveLength(5);
      await act(async () => rootButton(f.container, "Change starting point").click());
      await act(async () => rootButton(f.container, "Choose another start").click());
      await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Start simple"]')!.click());
      expect(f.container.querySelectorAll(".workflow-step-card")).toHaveLength(1);
      expect(f.container.querySelector<HTMLInputElement>("#workflow-name")?.value).toBe("My workflow");
      expect(f.props.save).not.toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it("selects the incomplete step on validation instead of leaving an offscreen error", async () => {
    const f = await editorFixture();
    try {
      await setText(f.container, "textarea", "  ");
      const implement = [...f.container.querySelectorAll<HTMLButtonElement>(".workflow-step-select")].find((button) => button.textContent?.includes("Implement"))!;
      await act(async () => implement.click());
      await act(async () => rootButton(f.container, "Create template").click());
      expect(f.props.save).not.toHaveBeenCalled();
      expect(f.container.querySelector(".workflow-inspector-head")?.textContent).toContain("Step 1 · Discuss");
      expect(f.container.querySelector('[role="alert"]')?.textContent).toBe("Step 1 needs instructions.");
    } finally { await f.dispose(); }
  });

  it("keeps replacement and discard controls disabled while creation is pending", async () => {
    let resolve!: (result: WorkflowConfiguration) => void;
    const f = await editorFixture({ save: vi.fn(() => new Promise<WorkflowConfiguration>((done) => { resolve = done; })) });
    try {
      await act(async () => rootButton(f.container, "Change starting point").click());
      await act(async () => f.container.querySelector<HTMLButtonElement>('[aria-label="Close workflow editor"]')!.click());
      await act(async () => rootButton(f.container, "Create template").click());
      expect(rootButton(f.container, "Choose another start").disabled).toBe(true);
      expect(rootButton(f.container, "Discard changes").disabled).toBe(true);
      expect(rootButton(f.container, "Change starting point").disabled).toBe(true);
      await act(async () => resolve(workflow));
      expect(f.props.close).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
  });
});
