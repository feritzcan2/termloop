// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFile } from "node:fs/promises";
import { URL as FileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, Task, WorkflowExecution } from "../src/renderer/model.js";
import { ActiveAgentRail, activeAgentQueryMatches, type ActiveAgentRailProps } from "../src/renderer/ui/ActiveAgentRail.js";
import { activeAgentWorkflowAction, activeAgentWorkflows, workflowAgentGroups, workflowAgentLabels } from "../src/renderer/ui/active-agent-workflows.js";
import { workflowAgentSegments } from "../src/renderer/ui/WorkflowAgentGroup.js";
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

describe("workflow agent groups", () => {
  it("keeps Taskless workflow groups and resume cues on exact Agents", () => {
    const run = execution({ taskId: null });
    const groups = workflowAgentGroups([run], sessions);
    expect(groups.size).toBe(3);
    expect(groups.get("lead")?.context).toContain("Project checkout");
    expect(activeAgentWorkflows([run], sessions).get("lead")?.[0]?.context).toContain("Project checkout");
  });
  it("groups only exact unarchived Agent members in the execution's project", () => {
    const values = [...sessions, agent("unrelated", { name: "Build and verify", ask_to_source_session_id: "lead" })];
    const groups = workflowAgentGroups([execution()], values, [task]);
    expect([...groups.keys()]).toEqual(["lead", "helper-a", "helper-b"]);
    expect(groups.get("lead")).toBe(groups.get("helper-a"));
    expect(groups.get("lead")?.context).toBe("Payments · Build and verify · Running");
    const unavailable = [agent("lead", { archived_at_epoch_ms: 3 }), agent("helper-a", { project_id: "other" }), agent("helper-b", { kind: "Terminal" })];
    expect(workflowAgentGroups([execution()], unavailable).size).toBe(0);
    expect(workflowAgentGroups([execution()], []).size).toBe(0);
  });

  it.each([
    ["approved", "Approved", false],
    ["completed", "Completed", false],
    ["changesRequested", "Changes requested", true],
    ["reviewLimitReached", "Review limit reached", true],
  ] as const)("keeps the finished %s outcome visible", (completionOutcome, statusLabel, needsAttention) => {
    const run = execution({ status: "completed", phase: "completed", completionOutcome });
    const groups = workflowAgentGroups([run], sessions);
    expect(groups.size).toBe(3);
    expect(groups.get("lead")).toMatchObject({ executionId: run.id, name: run.workflowName, status: "completed", statusLabel, needsAttention });
  });

  it("uses the most recent exact execution without mutating the projection or leaking another project's task", () => {
    const newer = execution({ id: "execution-2", status: "paused", updatedAtEpochMs: 5 });
    const runs = [newer, execution()];
    const groups = workflowAgentGroups(runs, sessions, [{ ...task, project_id: "other" }]);
    expect(groups.get("lead")).toMatchObject({ executionId: "execution-2", statusLabel: "Paused", context: "Build and verify · Paused" });
    expect(runs[0]).toBe(newer);
  });

  it("preserves row order and splits around helpers that do not belong to the workflow", () => {
    const values = [sessions[0]!, agent("ordinary", { ask_to_source_session_id: "lead" }), ...sessions.slice(1)];
    const segments = workflowAgentSegments(values, workflowAgentGroups([execution()], values));
    expect(segments.map((segment) => [segment.workflow?.executionId, segment.sessions.map((session) => session.id)]))
      .toEqual([["execution-1", ["lead"]], [undefined, ["ordinary"]], ["execution-1", ["helper-a", "helper-b"]]]);
    expect(segments.flatMap((segment) => segment.sessions)).toEqual(values);
    expect(workflowAgentSegments(values, undefined)).toEqual([{ workflow: undefined, sessions: values }]);
  });
});

describe("workflow agent role labels", () => {
  it("names the implementer and exact reviewers, including completed workflows", () => {
    const values = [agent("lead", { name: "Build and verify" }), agent("helper-a", { name: "Claude" }), agent("helper-b", { name: "Codex" }), agent("ordinary", { name: "Claude" })];
    const labels = workflowAgentLabels([execution({ status: "completed", phase: "completed" })], values);
    expect([...labels]).toEqual([["lead", "Implementer · Codex"], ["helper-a", "Reviewer · Claude"], ["helper-b", "Reviewer · Codex"]]);
    expect(values[0]?.name).toBe("Build and verify");
    expect(values[1]?.name).toBe("Claude");
  });

  it("changes a reused advisor to reviewer only once that step has an actual participant", () => {
    const run = execution({ participants: [{ stepId: "discuss", sessionId: "helper-a" }] });
    expect(workflowAgentLabels([run], sessions).get("helper-a")).toBe("Advisor · helper-a");
    expect(workflowAgentLabels([execution()], sessions).get("helper-a")).toBe("Reviewer · helper-a");
    expect(workflowAgentLabels([execution({ currentStepIndex: 4 })], sessions).get("lead")).toBe("Fixer · lead");
  });

  it("preserves custom names and ignores absent or cross-project sessions", () => {
    const values = [agent("lead", { name: "Payments lead" }), agent("helper-a", { name: "Security expert" }), agent("helper-b", { project_id: "elsewhere" })];
    expect([...workflowAgentLabels([execution()], values)]).toEqual([["lead", "Implementer · Payments lead"], ["helper-a", "Reviewer · Security expert"]]);
    expect(workflowAgentLabels([execution()], []).size).toBe(0);
  });
});

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
      workflowAgentLabelsBySessionId: workflowAgentLabels([run], values),
      workflowGroupsBySessionId: workflowAgentGroups([run], values, [task]),
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
    expect(action.getAttribute("aria-label")).toContain("Resume workflow:");
    expect(action.classList.contains("compact")).toBe(true);
    expect(action.closest(".active-agent-row")).not.toBeNull();
    expect(action.closest("[data-session-drop-target]")?.getAttribute("data-session-drop-target")).toBe("helper-a");
    expect(action.getAttribute("aria-label")).toContain("Payments · Build and verify");
    await act(async () => action.click());
    expect(props.resumeSession).toHaveBeenCalledExactlyOnceWith("helper-a");
    expect(props.selectSession).not.toHaveBeenCalled();
  });

  it("labels the workflow group and its final outcome while leaving ordinary helpers outside", async () => {
    const values = [...sessions, agent("ordinary", { ask_to_source_session_id: "lead" })];
    await render(values, execution({ status: "completed", phase: "completed", completionOutcome: "reviewLimitReached" }));
    const groups = [...container.querySelectorAll('[data-workflow-group="execution-1"]')];
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.getAttribute("aria-label")).toBe("Workflow · Payments · Build and verify · Review limit reached");
    expect(group.querySelector(".workflow-agent-group-title")?.textContent).toBe("Build and verify");
    expect(group.querySelector(".workflow-agent-group-status")?.textContent).toBe("Review limit reached");
    expect(group.classList.contains("needs-attention")).toBe(true);
    expect([...group.querySelectorAll("[data-session-id]")].map((row) => row.getAttribute("data-session-id"))).toEqual(["lead", "helper-a", "helper-b"]);
    expect(container.querySelector('[data-session-id="ordinary"]')?.closest("[data-workflow-group]")).toBeNull();
  });

  it("folds workflow members without affecting other agents or firing session actions", async () => {
    const closeWorkflow = vi.fn();
    const props = await render([...sessions, agent("ordinary")], execution(), { closeWorkflow });
    const group = container.querySelector('[data-workflow-group="execution-1"]')!;
    const toggle = group.querySelector<HTMLButtonElement>(".workflow-agent-group-toggle")!;
    const members = group.querySelector<HTMLElement>(".workflow-agent-group-members")!;
    expect(toggle.getAttribute("aria-controls")).toBe(members.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(members.hidden).toBe(true);
    expect(container.querySelector('[data-session-id="ordinary"]')?.closest("[hidden]")).toBeNull();
    expect(props.selectSession).not.toHaveBeenCalled();
    expect(props.resumeSession).not.toHaveBeenCalled();
    expect(closeWorkflow).not.toHaveBeenCalled();
    await act(async () => toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(props.navigateSession).toHaveBeenCalledExactlyOnceWith("ordinary");
    await act(async () => toggle.click());
    expect(members.hidden).toBe(false);
    await act(async () => members.querySelector<HTMLButtonElement>('[data-session-id="helper-a"]')!.click());
    expect(props.selectSession).toHaveBeenCalledExactlyOnceWith("helper-a");
    await act(async () => members.querySelector<HTMLButtonElement>('.active-agent-favorite')!.click());
    expect(props.toggleFavoriteSession).toHaveBeenCalledExactlyOnceWith("lead");
  });

  it("reveals a folded workflow when agent search opens", async () => {
    await render(sessions, execution());
    await act(async () => container.querySelector<HTMLButtonElement>(".workflow-agent-group-toggle")!.click());
    expect(container.querySelector<HTMLElement>(".workflow-agent-group-members")!.hidden).toBe(true);
    await render(sessions, execution(), { searchOpen: true });
    expect(container.querySelector<HTMLElement>(".workflow-agent-group-members")!.hidden).toBe(false);
  });

  it("retains an explicitly detached helper as a separate root without losing workflow identification", async () => {
    await render(sessions, execution(), { detachedRelationshipSessionIds: new Set(["helper-a"]) });
    const helper = container.querySelector('[data-session-id="helper-a"]')!;
    expect(helper.closest(".active-agent-helper-row")).toBeNull();
    expect(helper.closest("[data-workflow-group]")?.getAttribute("data-workflow-group")).toBe("execution-1");
    expect(container.querySelectorAll("[data-session-id]")).toHaveLength(3);
  });

  it("offers a visible whole-workflow close intent even from a detached group segment", async () => {
    const closeWorkflow = vi.fn();
    await render(sessions, execution(), { closeWorkflow, detachedRelationshipSessionIds: new Set(["helper-a"]) });
    const group = container.querySelector('[data-session-id="helper-a"]')!.closest('[data-workflow-group]')!;
    const action = group.querySelector<HTMLButtonElement>('.workflow-agent-group-close')!;
    expect(action.querySelector("svg")).not.toBeNull();
    expect(action.getAttribute("aria-label")).toBe("Close all agents in workflow Build and verify");
    await act(async () => action.click());
    expect(closeWorkflow).toHaveBeenCalledExactlyOnceWith("execution-1");
  });

  it("disables the workflow close action while disconnected", async () => {
    const closeWorkflow = vi.fn();
    await render(sessions, execution(), { closeWorkflow, workflowActionsDisabled: true });
    const action = container.querySelector<HTMLButtonElement>('.workflow-agent-group-close')!;
    expect(action.disabled).toBe(true);
    await act(async () => action.click());
    expect(closeWorkflow).not.toHaveBeenCalled();
  });

  it.each([0, 12])("shows a shared checkout and %i changes only once with a working group-level action", async (changeCount) => {
    const values = sessions.map((session) => ({ ...session, process: { ...session.process, cwd: "/repo/worktrees/feature-payments" } }));
    // Helpers already inherit their exact source's checkout change projection.
    const worktreeChangesBySessionId = new Map([["lead", { taskId: "task-1", taskTitle: "Payments", changeCount }]]);
    const props = await render(values, execution(), { worktreeChangesBySessionId });
    const group = container.querySelector('[data-workflow-group="execution-1"]')!;
    expect(group.querySelector('.workflow-agent-group-checkout')?.textContent).toBe("feature-payments");
    expect(group.querySelector('.workflow-agent-group-checkout')?.getAttribute("title")).toBe("/repo/worktrees/feature-payments");
    expect(group.querySelectorAll('.row-subtitle')).toHaveLength(0);
    expect(group.querySelectorAll('.active-agent-worktree-changes')).toHaveLength(0);
    expect(group.querySelectorAll('.active-agent-row.has-worktree-changes')).toHaveLength(0);
    const action = group.querySelector<HTMLButtonElement>('.workflow-agent-group-changes')!;
    expect(action.textContent).toBe(`${changeCount} changes`);
    await act(async () => action.click());
    expect(props.openTaskChanges).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(props.selectSession).not.toHaveBeenCalled();
    expect(group.querySelectorAll('.active-agent-favorite')).toHaveLength(3);
    expect(group.querySelectorAll('.active-agent-workflow')).toHaveLength(1);
  });

  it("keeps unknown changes unknown and labels the Project checkout once", async () => {
    await render(sessions, execution({ taskId: null }));
    expect(container.querySelector('.workflow-agent-group-checkout')?.textContent).toBe("Project checkout");
    expect(container.querySelectorAll('.workflow-agent-group-changes')).toHaveLength(0);
    expect(container.querySelectorAll('.row-subtitle')).toHaveLength(0);
  });

  it("never collapses different checkouts with the same basename", async () => {
    const values = sessions.map((session, index) => ({ ...session, process: { ...session.process, cwd: index === 2 ? "/other/feature-payments" : "/repo/feature-payments" } }));
    await render(values, execution(), { worktreeChangesBySessionId: new Map(values.map((session) => [session.id, { taskId: "task-1", taskTitle: "Payments", changeCount: 4 }])) });
    expect(container.querySelector('.workflow-agent-group-meta')).toBeNull();
    expect([...container.querySelectorAll('.row-subtitle')].map((node) => node.getAttribute("title"))).toEqual(["/repo/feature-payments", "/repo/feature-payments", "/other/feature-payments"]);
    expect(container.querySelectorAll('.active-agent-worktree-changes')).toHaveLength(3);
  });

  it.each(["taskId", "changeCount", "taskTitle"] as const)("keeps conflicting %s projections on their own rows", async (field) => {
    const changes = { taskId: "task-1", taskTitle: "Payments", changeCount: 4 };
    await render(sessions, execution(), { worktreeChangesBySessionId: new Map(sessions.map((session, index) => [session.id, index === 2 ? { ...changes, [field]: field === "changeCount" ? 8 : "different" } : changes])) });
    expect(container.querySelectorAll('.workflow-agent-group-checkout')).toHaveLength(1);
    expect(container.querySelector('.workflow-agent-group-changes')).toBeNull();
    expect(container.querySelectorAll('.active-agent-worktree-changes')).toHaveLength(3);
  });

  it("updates shared counts and preserves agent-specific state and ordinary helper metadata", async () => {
    const values = [...sessions, agent("ordinary", { ask_to_source_session_id: "lead" })].map((session) => ({ ...session, process: { ...session.process, cwd: "/repo/worktrees/feature-payments" } }));
    const overrides = {
      worktreeChangesBySessionId: new Map([["lead", { taskId: "task-1", taskTitle: "Payments", changeCount: 4 }]]),
      statusesById: new Map([["helper-a", { sessionId: "helper-a", status: "working" as const, source: "appServer" as const, observedAtEpochMs: 3 }]]),
    };
    await render(values, execution(), overrides);
    const group = container.querySelector('[data-workflow-group="execution-1"]')!;
    expect(group.querySelector('[data-session-id="helper-a"] .row-state')?.textContent).toBe("Working");
    expect(container.querySelector('[data-session-id="ordinary"] .row-subtitle')?.textContent).toBe("feature-payments");
    expect(container.querySelectorAll('.active-agent-worktree-changes')).toHaveLength(1);
    await render(values, execution(), { ...overrides, worktreeChangesBySessionId: new Map([["lead", { taskId: "task-1", taskTitle: "Payments", changeCount: 9 }]]) });
    expect(container.querySelector('.workflow-agent-group-changes')?.textContent).toBe("9 changes");
  });

  it.each(["Payments", "Build and verify", "Review limit reached"])("finds completed workflow groups by %s", async (query) => {
    await render([...sessions, agent("ordinary")], execution({ status: "completed", phase: "completed", completionOutcome: "reviewLimitReached" }), { searchOpen: true });
    const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...container.querySelectorAll("[data-session-id]")].map((row) => row.getAttribute("data-session-id"))).toEqual(["lead", "helper-a", "helper-b"]);
  });

  it("opens the running agent without resuming or interrupting it", async () => {
    const props = await render(sessions, execution({ currentStepIndex: 1 }));
    const action = container.querySelector<HTMLButtonElement>(".active-agent-workflow")!;
    expect(action.getAttribute("aria-label")).toContain("Open workflow:");
    expect(action.getAttribute("title")).toContain("Implement");
    await act(async () => action.click());
    expect(props.selectSession).toHaveBeenCalledExactlyOnceWith("lead");
    expect(props.resumeSession).not.toHaveBeenCalled();
  });

  it("renders role names in agent rows and accessible labels without losing custom names", async () => {
    await render([agent("lead", { name: "Build and verify" }), agent("helper-a", { name: "Claude", ask_to_source_session_id: "lead" })], execution({ status: "completed", phase: "completed" }));
    const lead = container.querySelector('[data-session-id="lead"]')!;
    const reviewer = container.querySelector('[data-session-id="helper-a"]')!;
    expect(lead.querySelector(".row-title")?.textContent).toBe("Implementer · Codex");
    expect(lead.querySelector(".row-agent")).toBeNull();
    expect(reviewer.querySelector(".row-title")?.textContent).toBe("Reviewer · Claude");
    expect(reviewer.getAttribute("aria-label")).toContain("Reviewer · Claude");
    expect(container.querySelector(".active-agent-workflow")).toBeNull();
    await render([agent("lead", { name: "My payments agent" })], execution());
    expect(container.querySelector(".row-title")?.textContent).toBe("Implementer · My payments agent");
  });

  it("finds a finished workflow's agents by role and keeps their group together", async () => {
    await render([...sessions, agent("ordinary")], execution({ status: "completed", phase: "completed" }), { searchOpen: true });
    const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "reviewer");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...container.querySelectorAll("[data-session-id]")].map((row) => row.getAttribute("data-session-id"))).toEqual(["lead", "helper-a", "helper-b"]);
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
    expect(container.querySelector(".active-agent-workflow")?.getAttribute("aria-label")).toContain("Resume workflow");
    const props = await render([agent("lead", { lifecycle_state: "resuming", retryable: true })], execution());
    const action = container.querySelector<HTMLButtonElement>(".active-agent-workflow")!;
    expect(action.getAttribute("aria-label")).toContain("Open workflow");
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
