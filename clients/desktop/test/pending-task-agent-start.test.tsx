// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/renderer/model.js";
import { taskAgentStartReadiness, usePendingTaskAgentStarts } from "../src/renderer/pending-task-agent-start.js";

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
    worktree_health: {
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
    },
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
    ...overrides,
  } as Task;
}

let roots: Root[] = [];
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

/// Renders a hook and exposes its latest value; rerender passes new props.
function renderHook<P, R>(hook: (props: P) => R, options: { initialProps: P } = { initialProps: undefined as P }) {
  const result = { current: undefined as R };
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  function Probe({ props }: { props: P }) { result.current = hook(props); return null; }
  act(() => root.render(<Probe props={options.initialProps} />));
  return { result, rerender: (props: P) => act(() => root.render(<Probe props={props} />)) };
}

const unobserved = () => task({ worktree_health: null } as Partial<Task>);
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("Task agent start readiness", () => {
  it("starts only on a launch-ready worktree and waits while it converges", () => {
    expect(taskAgentStartReadiness(task())).toBe("ready");
    expect(taskAgentStartReadiness(unobserved())).toBe("wait");
    expect(taskAgentStartReadiness(task({ worktree_provisioning: { status: "running", operation_id: "op" } } as Partial<Task>))).toBe("wait");
    expect(taskAgentStartReadiness(task({ status: "closed" }))).toEqual({ failure: "The Task is closed." });
  });
});

describe("Pending Task agent starts", () => {
  it("holds the start until the worktree is observed, then clears on success", async () => {
    const run = vi.fn(async () => undefined);
    const report = vi.fn();
    const { result, rerender } = renderHook(({ tasks }) => usePendingTaskAgentStarts(tasks, report), { initialProps: { tasks: [unobserved()] } });
    act(() => result.current.begin("task-1", "fork", "PAY-1", run));
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(result.current.views.get("task-1")).toMatchObject({ phase: "waiting", kind: "fork" });

    rerender({ tasks: [task()] });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.views.has("task-1")).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it("keeps a failed start on the card and retries it on request", async () => {
    const run = vi.fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("The forked Agent did not become ready before the startup timeout. Retry the fork.")
      .mockResolvedValueOnce(undefined);
    const report = vi.fn();
    const { result } = renderHook(() => usePendingTaskAgentStarts([task()], report));
    act(() => result.current.begin("task-1", "fork", "PAY-1", run));
    await flush();
    expect(result.current.views.get("task-1")).toMatchObject({ phase: "failed", failure: expect.stringContaining("startup timeout") });
    expect(report).toHaveBeenCalledWith("PAY-1", expect.stringContaining("startup timeout"));

    act(() => result.current.retry("task-1"));
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.current.views.has("task-1")).toBe(false);
  });

  it("fails without launching when the worktree cannot host an Agent", async () => {
    const run = vi.fn(async () => undefined);
    const report = vi.fn();
    const { result } = renderHook(() => usePendingTaskAgentStarts([task({ status: "closed" })], report));
    act(() => result.current.begin("task-1", "fresh", "PAY-1", run));
    await flush();
    expect(run).not.toHaveBeenCalled();
    expect(result.current.views.get("task-1")).toMatchObject({ phase: "failed", failure: "The Task is closed." });
    act(() => result.current.dismiss("task-1"));
    expect(result.current.views.has("task-1")).toBe(false);
  });
});
