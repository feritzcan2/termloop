// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFile } from "node:fs/promises";
import { URL as FileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Task, WorkflowExecution } from "../src/renderer/model.js";
import { ActiveAgentRail, activeAgentQueryMatches, type ActiveAgentRailProps } from "../src/renderer/ui/ActiveAgentRail.js";
import { activeAgentWorkflowAction, activeAgentWorkflows } from "../src/renderer/ui/active-agent-workflows.js";
import { workflowConfiguration } from "./workflow-fixture.js";

function agent(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id, project_id: "project-1", name: id, kind: "Agent", lifecycle_state: "running", runtime_epoch: 1,
    archived_at_epoch_ms: null, resume_failure_reason: null, retryable: false, closable: false,
    forkable: false, ask_to_source_session_id: null,
    process: { program: "codex", args: [], cwd: "/repo", agent_id: "codex", template_ref: "builtin.agent.interactive", template_version: null },
    ...overrides,
  } as Session;
}

function execution(overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  const step = workflowConfiguration().steps[0]!;
  return {
    id: "execution-1", projectId: "project-1", taskId: "task-1", workflowId: "workflow-1", workflowGeneration: 1,
    workflowName: "Build and verify", goal: "Ship payments", coordinatorSessionId: "lead",
    currentStepIndex: 0, reviewCycle: 1, maxReviewCycles: 2, phase: "awaitingCoordinator", status: "running",
    completionOutcome: null,
    steps: [
      { ...step, id: "discuss", kind: "discuss", title: "Discuss", agentId: "claude" },
      { ...step, id: "implement" },
      { ...step, id: "review-a", kind: "review", title: "Review code", agentId: "claude", reuseStepId: "discuss" },
      { ...step, id: "review-b", kind: "review", title: "Review tests", agentId: "codex" },
      { ...step, id: "fix", kind: "fix", title: "Fix findings" },
    ],
    participants: [{ stepId: "discuss", sessionId: "helper-a" }, { stepId: "review-a", sessionId: "helper-a" }, { stepId: "review-b", sessionId: "helper-b" }],
    activeReviewStepIds: [], pendingReviewStepIds: [], stepResults: [], startedAtEpochMs: 1, updatedAtEpochMs: 2,
    ...overrides,
  };
}

const sessions = [agent("lead"), agent("helper-a", { ask_to_source_session_id: "lead" }), agent("helper-b", { ask_to_source_session_id: "lead" })];
const task = { id: "task-1", project_id: "project-1", title: "Payments" } as Task;

describe("unfinished workflow agent cues", () => {
  it.each([0, 1, 4])("marks the lead for coordinator-owned step %i, not old helpers", (currentStepIndex) => {
    const cues = activeAgentWorkflows([execution({ currentStepIndex })], sessions, [task]);
    expect([...cues.keys()]).toEqual(["lead"]);
    expect(cues.get("lead")?.[0]?.context).toContain("Payments · Build and verify");
  });

  it("uses the exact discussion participant after restoring the execution snapshot", () => {
    const restored = JSON.parse(JSON.stringify(execution({ phase: "awaitingHelper" }))) as WorkflowExecution;
    expect([...activeAgentWorkflows([restored], sessions).keys()]).toEqual(["helper-a"]);
    expect([...activeAgentWorkflows([{ ...restored, phase: "awaitingStepCompletion" }], sessions).keys()]).toEqual(["lead"]);
  });

  it("marks every pending parallel reviewer, excluding already delivered replies", () => {
    const review = execution({ currentStepIndex: 2, phase: "awaitingHelper", activeReviewStepIds: ["review-a", "review-b"], pendingReviewStepIds: ["review-a", "review-b"] });
    const cues = activeAgentWorkflows([review], sessions);
    expect([...cues.keys()]).toEqual(["helper-a", "helper-b"]);
    expect(cues.get("helper-b")?.[0]?.stepLabel).toBe("4/5 Review tests");
    expect([...activeAgentWorkflows([{ ...review, pendingReviewStepIds: ["review-b"] }], sessions).keys()]).toEqual(["helper-b"]);
    expect([...activeAgentWorkflows([{ ...review, phase: "awaitingStepCompletion", pendingReviewStepIds: [] }], sessions).keys()]).toEqual(["lead"]);
  });

  it("keeps the lead visible while it is still assigning the parallel group", () => {
    const review = execution({ currentStepIndex: 2, activeReviewStepIds: ["review-a"], pendingReviewStepIds: ["review-a"] });
    expect([...activeAgentWorkflows([review], sessions).keys()]).toEqual(["helper-a", "lead"]);
  });

  it("does not mistake old review participants for the current review cycle", () => {
    const review = execution({ currentStepIndex: 2, reviewCycle: 2 });
    const cues = activeAgentWorkflows([review], sessions);
    expect([...cues.keys()]).toEqual(["lead"]);
    expect(cues.get("lead")?.[0]?.context).toContain("Review cycle 2");
  });

  it("also surfaces a stopped lead while helpers are still responsible for replies", () => {
    const values = [agent("lead", { lifecycle_state: "stale", retryable: true }), sessions[1]!];
    const cues = activeAgentWorkflows([execution({ phase: "awaitingHelper", status: "paused" })], values);
    expect([...cues.keys()]).toEqual(["helper-a", "lead"]);
    expect(cues.get("lead")?.[0]?.stepLabel).toContain("Lead paused");
  });

  it("falls back to the existing lead for an unavailable helper without inventing ownership", () => {
    const cues = activeAgentWorkflows([execution({ phase: "awaitingHelper" })], [sessions[0]!, agent("unrelated")]);
    expect([...cues.keys()]).toEqual(["lead"]);
    expect(cues.get("lead")?.[0]?.stepLabel).toContain("Helper unavailable");
  });

  it("never marks completed executions, archived agents, other projects or missing descriptors", () => {
    expect(activeAgentWorkflows([execution({ phase: "completed" })], sessions).size).toBe(0);
    expect(activeAgentWorkflows([execution({ status: "completed" })], sessions).size).toBe(0);
    expect(activeAgentWorkflows([execution()], [agent("lead", { archived_at_epoch_ms: 3 })]).size).toBe(0);
    expect(activeAgentWorkflows([execution()], [agent("lead", { project_id: "elsewhere" })]).size).toBe(0);
    expect(activeAgentWorkflows([execution()], []).size).toBe(0);
    expect(activeAgentWorkflows([execution({ currentStepIndex: 99 })], sessions).size).toBe(0);
  });

  it("retains separate execution cues if an exact participant appears in more than one run", () => {
    const cues = activeAgentWorkflows([execution(), execution({ id: "execution-2", taskId: "task-2", workflowName: "Another workflow" })], sessions);
    expect(cues.get("lead")?.map((cue) => cue.executionId)).toEqual(["execution-1", "execution-2"]);
  });

  it("uses preserved workflow context for search without depending on saved templates", () => {
    const cues = activeAgentWorkflows([execution()], sessions, [task]).get("lead");
    expect(activeAgentQueryMatches(sessions[0]!, "payments", cues)).toBe(true);
    expect(activeAgentQueryMatches(sessions[0]!, "build and verify", cues)).toBe(true);
    expect(activeAgentQueryMatches(sessions[0]!, "discuss", cues)).toBe(true);
    expect(activeAgentQueryMatches(sessions[1]!, "payments")).toBe(false);
  });

  it("offers resume only for daemon-projected recoverable stopped agents", () => {
    expect(activeAgentWorkflowAction(agent("lead", { lifecycle_state: "stale", retryable: true }))).toEqual({ label: "Resume workflow", resume: true });
    expect(activeAgentWorkflowAction(agent("lead", { lifecycle_state: "resumeFailed", retryable: true, resume_failure_reason: "providerHistoryDamaged" }))).toEqual({ label: "Fix & resume workflow", resume: true });
    for (const lifecycle_state of ["running", "resuming", "stale"] as const) {
      expect(activeAgentWorkflowAction(agent("lead", { lifecycle_state }))).toEqual({ label: "Open workflow", resume: false });
    }
    expect(activeAgentWorkflowAction(agent("lead", { lifecycle_state: "resuming", retryable: true })).resume).toBe(false);
  });
});

describe("workflow actions in the Agents rail", () => {
  it("allows long workflow labels to shrink in both root and nested agent rows", async () => {
    const css = await readFile(new FileURL("../src/app.css", import.meta.url), "utf8");
    expect(css).toContain(".active-agent-list { display: grid; grid-template-columns: minmax(0,1fr);");
    expect(css).toContain(".active-agent-helper-row { display: block; min-width: 0; }");
  });

  let root: Root | undefined;
  let container: HTMLDivElement;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
  });
  async function render(values: readonly Session[], run: WorkflowExecution, overrides: Partial<ActiveAgentRailProps> = {}) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (!root) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    const props: ActiveAgentRailProps = {
      sessions: values, projectFolder: "/repo", selectedSession: undefined, visibleSessionIds: new Set(), statusesById: new Map(),
      reviewReadySessionIds: new Set(), favoriteSessionIds: new Set(), taskAttachedSessionIds: new Set(), worktreeChangesBySessionId: new Map(),
      workflowsBySessionId: activeAgentWorkflows([run], values, [task]), menuSessionId: undefined,
      selectSession: vi.fn(), navigateSession: vi.fn(), openSessionMenu: vi.fn(), dismissSession: vi.fn(), resumeSession: vi.fn(), archiveSession: vi.fn(),
      toggleFavoriteSession: vi.fn(), openTaskChanges: vi.fn(), searchOpen: false, setSearchOpen: vi.fn(), nowEpochMs: 100,
      ...overrides,
    };
    await act(async () => root!.render(createElement(ActiveAgentRail, props)));
    return props;
  }

  it("resumes the exact stopped helper through the existing resume intent", async () => {
    const values = [sessions[0]!, agent("helper-a", { lifecycle_state: "stale", retryable: true, ask_to_source_session_id: "lead" })];
    const props = await render(values, execution({ phase: "awaitingHelper" }));
    const action = container.querySelector<HTMLButtonElement>(".active-agent-workflow")!;
    expect(action.textContent).toBe("Resume workflow1/5 Discuss");
    expect(action.closest("[data-session-drop-target]")?.getAttribute("data-session-drop-target")).toBe("helper-a");
    expect(action.getAttribute("aria-label")).toContain("Payments · Build and verify");
    await act(async () => action.click());
    expect(props.resumeSession).toHaveBeenCalledExactlyOnceWith("helper-a");
    expect(props.selectSession).not.toHaveBeenCalled();
  });

  it("opens the running agent without resuming or interrupting it", async () => {
    const props = await render(sessions, execution({ currentStepIndex: 1 }));
    const action = container.querySelector<HTMLButtonElement>(".active-agent-workflow")!;
    expect(action.textContent).toBe("Open workflow2/5 Implement");
    await act(async () => action.click());
    expect(props.selectSession).toHaveBeenCalledExactlyOnceWith("lead");
    expect(props.resumeSession).not.toHaveBeenCalled();
  });

  it("moves the cue with the durable step and removes it on completion", async () => {
    await render(sessions, execution({ phase: "awaitingHelper" }));
    expect(container.querySelector(".active-agent-workflow")?.closest("[data-session-drop-target]")?.getAttribute("data-session-drop-target")).toBe("helper-a");
    await render(sessions, execution({ currentStepIndex: 1 }));
    expect(container.querySelector(".active-agent-workflow")?.closest("[data-session-drop-target]")?.getAttribute("data-session-drop-target")).toBe("lead");
    await render(sessions, execution({ phase: "completed", status: "completed" }));
    expect(container.querySelector(".active-agent-workflow")).toBeNull();
    expect(container.querySelectorAll("[data-session-id]")).toHaveLength(3);
  });

  it("updates a stopped cue after resume without offering another retry", async () => {
    await render([agent("lead", { lifecycle_state: "stale", retryable: true })], execution({ status: "paused" }));
    expect(container.querySelector(".active-agent-workflow")?.textContent).toContain("Resume workflow");
    const props = await render([agent("lead", { lifecycle_state: "resuming", retryable: true })], execution());
    const action = container.querySelector<HTMLButtonElement>(".active-agent-workflow")!;
    expect(action.textContent).toContain("Open workflow");
    await act(async () => action.click());
    expect(props.resumeSession).not.toHaveBeenCalled();
  });

  it("searches workflow context while preserving the helper's exact source group", async () => {
    await render([...sessions, agent("unrelated")], execution({ phase: "awaitingHelper" }), { searchOpen: true });
    const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Payments");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...container.querySelectorAll("[data-session-id]")].map((row) => row.getAttribute("data-session-id"))).toEqual(["lead", "helper-a", "helper-b"]);
  });
});
