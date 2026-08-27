// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { ActiveAgentRail, type ActiveAgentRailProps } from "../src/renderer/ui/ActiveAgentRail.js";

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

function props(sessions: readonly Session[], statuses: readonly AgentStatus[], overrides: Partial<ActiveAgentRailProps> = {}): ActiveAgentRailProps {
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
    nowEpochMs: 100,
    ...overrides,
  };
}

async function renderRail(railProps: ActiveAgentRailProps): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(ActiveAgentRail, railProps)));
  return { container, root };
}

describe("Active Agent rail first-run empty state", () => {
  it("teaches the Shift Shift chord instead of printing empty state buckets", async () => {
    const openQuickAction = vi.fn();
    const { container, root } = await renderRail(props([], [], { openQuickAction }));

    const empty = container.querySelector(".agent-empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("Shift Shift");
    expect(container.querySelector(".rail-empty")).toBeNull();
    expect(container.querySelectorAll("[data-active-agent-section]").length).toBe(0);

    await act(async () => container.querySelector<HTMLButtonElement>(".agent-empty-create")!.click());
    expect(openQuickAction).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("keeps the copy but drops the action when launching is unavailable", async () => {
    const { container, root } = await renderRail(props([], []));

    expect(container.querySelector(".agent-empty")).not.toBeNull();
    expect(container.querySelector(".agent-empty-create")).toBeNull();
    await act(async () => root.unmount());
  });

  it("returns to the ordinary buckets as soon as one agent is running", async () => {
    const running = agent("running");
    const { container, root } = await renderRail(props([running], [status(running.id, "idle")], { openQuickAction: () => {} }));

    expect(container.querySelector(".agent-empty")).toBeNull();
    expect(container.querySelector('[data-active-agent-section="Idle / paused"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});
