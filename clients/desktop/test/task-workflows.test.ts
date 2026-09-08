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
      stateRevision: 1,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")],
      agentProfiles: [edgeCaseHunter],
      close: vi.fn(),
      save: vi.fn(),
      remove: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Add workflow steps"');
    expect(markup).toContain('aria-label="Workflow flow"');
    expect(markup).toContain("2 parallel reviewers");
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

    expect(container.querySelector<HTMLSelectElement>('[aria-label="Coordinator Model"]')?.value).toBe("default");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Coordinator Permission"]')?.value).toBe("bypassPermissions");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Coordinator Thinking"]')?.value).toBe("default");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Step Model"]')?.value).toBe("default");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Step Permission"]')?.value).toBe("bypassPermissions");
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Step Thinking"]')?.value).toBe("default");

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

    const review = [...container.querySelectorAll<HTMLButtonElement>(".workflow-step-select")]
      .find((button) => button.textContent?.includes("Independent second review"));
    await act(async () => review!.click());
    const template = container.querySelector<HTMLSelectElement>('[aria-label="Agent template"]')!;
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

  it("renders a saved workflow as one Task launcher with an editable workflow entry", () => {
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

    expect(markup).toContain('aria-label="Run workflow Discuss, build, review in Add simple workflows"');
    expect(markup).toContain('title="1 discussion in order → Implement → 1 reviewer"');
    expect(markup).toContain('aria-label="Edit workflow Discuss, build, review"');
    expect(markup).toContain('aria-label="Add workflow"');
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

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit workflow Discuss, build, review"]')!.click());
    expect(edit).toHaveBeenLastCalledWith(workflow);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add workflow"]')!.click());
    expect(edit).toHaveBeenLastCalledWith(undefined);

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

    expect(markup).toContain('aria-label="Run workflow Discuss, build, review in Add simple workflows"');
    expect(markup).not.toContain("disabled");
  });

  it("shows the Core-owned current step and prevents a second workflow on the same Task", () => {
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
    expect(markup).not.toContain('aria-label="Add workflow"');
  });
});

async function editorFixture(overrides: Partial<ComponentProps<typeof WorkflowEditorPanel>> = {}) {
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
  return { container, root, props, async dispose() {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  } };
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
      await act(async () => rootButton(f.container, "Save template").click());
      expect(f.container.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
      await act(async () => f.container.querySelector(".workflow-editor-stage")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(f.props.close).not.toHaveBeenCalled();
      await act(async () => resolve(workflow));
      expect(f.props.close).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
    const rejected = await editorFixture({ save: vi.fn(async () => { throw new Error("Save unavailable"); }) });
    try {
      await act(async () => rootButton(rejected.container, "Save template").click());
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
