// @vitest-environment jsdom

import { Fragment, act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { ActiveAgentRail, activeAgentQueryMatches, type ActiveAgentRailProps } from "../src/renderer/ui/ActiveAgentRail.js";

function agent(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project_id: "project-1",
    name: id,
    kind: "Agent",
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
    ask_to_source_session_id: null,
    process: {
      program: "/usr/local/bin/codex",
      args: [],
      cwd: `/repo/${id}`,
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: null,
    },
    ...overrides,
  } as Session;
}

function status(sessionId: string, value: AgentStatus["status"], observedAtEpochMs = 1): AgentStatus {
  return { sessionId, status: value, source: "appServer", observedAtEpochMs };
}

function props(sessions: readonly Session[], statuses: readonly AgentStatus[]): ActiveAgentRailProps {
  return {
    sessions,
    projectFolder: "/repo/termloop-next",
    selectedSession: undefined,
    visibleSessionIds: new Set(),
    statusesById: new Map(statuses.map((value) => [value.sessionId, value])),
    reviewReadySessionIds: new Set(),
    favoriteSessionIds: new Set(),
    taskAttachedSessionIds: new Set(),
    worktreeChangesBySessionId: new Map(),
    menuSessionId: undefined,
    selectSession: () => {},
    navigateSession: () => {},
    openSessionMenu: () => {},
    dismissSession: () => {},
    resumeSession: () => {},
    archiveSession: () => {},
    toggleFavoriteSession: () => {},
    openTaskChanges: () => {},
    searchOpen: false,
    setSearchOpen: () => {},
  };
}

/// The search toggle lives in the Shell's tab bar, so the tests stand in for it
/// with a controlled toggle of their own; the rail owns only the query.
function SearchHarness(railProps: ActiveAgentRailProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  return createElement(
    Fragment,
    null,
    createElement("button", { type: "button", className: "active-agent-search-toggle", "aria-expanded": searchOpen, onClick: () => setSearchOpen(!searchOpen) }),
    createElement(ActiveAgentRail, { ...railProps, searchOpen, setSearchOpen }),
  );
}

async function renderRail(railProps: ActiveAgentRailProps): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(SearchHarness, railProps)));
  return { container, root };
}

async function openSearch(container: HTMLElement): Promise<HTMLInputElement> {
  const toggle = container.querySelector<HTMLButtonElement>(".active-agent-search-toggle");
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
  const input = container.querySelector<HTMLInputElement>(".active-agent-search input");
  expect(input).not.toBeNull();
  return input!;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-session-id]")].map((row) => row.getAttribute("data-session-id") ?? "");
}

describe("Active Agent search", () => {
  it("shows a Task worktree change count and opens its local Changes editor", async () => {
    const working = agent("working");
    const openTaskChanges = vi.fn();
    const railProps = props([working], [status(working.id, "working")]);
    railProps.worktreeChangesBySessionId = new Map([[working.id, {
      taskId: "task-1",
      taskTitle: "Ship agent change count",
      changeCount: 50,
    }]]);
    railProps.openTaskChanges = openTaskChanges;
    const { container, root } = await renderRail(railProps);

    const changes = container.querySelector<HTMLButtonElement>(".active-agent-worktree-changes");
    expect(changes?.textContent).toBe("50 changes");
    expect(changes?.getAttribute("aria-label")).toBe("Review 50 changes in Ship agent change count");
    await act(async () => changes?.click());
    expect(openTaskChanges).toHaveBeenCalledOnce();
    expect(openTaskChanges).toHaveBeenCalledWith("task-1");

    await act(async () => root.render(createElement(ActiveAgentRail, {
      ...railProps,
      worktreeChangesBySessionId: new Map([[working.id, {
        taskId: "task-1",
        taskTitle: "Ship agent change count",
        changeCount: 0,
      }]]),
    })));
    expect(container.querySelector(".active-agent-worktree-changes")?.textContent).toBe("0 changes");
    await act(async () => root.unmount());
  });

  it("matches the visible label and the worktree folder name case-insensitively", () => {
    const named = agent("named", { name: "Payments refactor" });
    const worktree = agent("worktree", {
      name: null,
      process: { ...agent("base").process, cwd: "/repo/.worktrees/keep_awake" },
    } as Partial<Session>);

    expect(activeAgentQueryMatches(named, "payments")).toBe(true);
    expect(activeAgentQueryMatches(named, "refac")).toBe(true);
    expect(activeAgentQueryMatches(named, "codex")).toBe(false);
    expect(activeAgentQueryMatches(worktree, "keep_awake")).toBe(true);
  });

  it("filters rows while typing and restores every row when search closes", async () => {
    const alpha = agent("alpha");
    const bravo = agent("bravo");
    const { container, root } = await renderRail(props(
      [alpha, bravo],
      [status(alpha.id, "working"), status(bravo.id, "idle")],
    ));

    const input = await openSearch(container);
    await type(input, "ALP");
    expect(rowIds(container)).toEqual(["alpha"]);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".active-agent-search-toggle")!.click();
    });
    expect(container.querySelector(".active-agent-search")).toBeNull();
    expect(rowIds(container).sort()).toEqual(["alpha", "bravo"]);
    await act(async () => root.unmount());
  });

  it("keeps an Ask-To group whole when only the helper matches", async () => {
    const source = agent("source", { name: "Source agent" });
    const helper = agent("helper", { name: "Helper agent", ask_to_source_session_id: source.id });
    const other = agent("other");
    const { container, root } = await renderRail(props(
      [source, helper, other],
      [status(source.id, "idle"), status(helper.id, "idle"), status(other.id, "idle")],
    ));

    const input = await openSearch(container);
    await type(input, "helper");
    expect(rowIds(container)).toEqual(["source", "helper"]);
    await act(async () => root.unmount());
  });

  it("shows a no-match empty state and keeps the attention count global", async () => {
    const waiting = agent("waiting");
    const { container, root } = await renderRail(props([waiting], [status(waiting.id, "awaitingInput")]));

    const input = await openSearch(container);
    await type(input, "zzz");
    expect(rowIds(container)).toEqual([]);
    expect(container.querySelector(".rail-empty")?.textContent).toBe("No matching agents");

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".active-agent-search")).toBeNull();
    expect(rowIds(container)).toEqual(["waiting"]);
    await act(async () => root.unmount());
  });
});
