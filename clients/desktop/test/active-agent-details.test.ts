// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { ActiveAgentRail } from "../src/renderer/ui/ActiveAgentRail.js";

const agent: Session = {
  id: "agent-details",
  project_id: "project-1",
  name: "Detail agent",
  kind: "Agent",
  lifecycle_state: "running",
  runtime_epoch: 1,
  archived_at_epoch_ms: null,
  resume_failure_reason: null,
  retryable: false,
  closable: false,
  forkable: false,
  ask_to_source_session_id: null,
  run_configuration_id: null,
  process: {
    program: "/usr/local/bin/codex",
    args: [],
    cwd: "/repo/detail-worktree",
    agent_id: "codex",
    template_ref: "builtin.agent.interactive",
    template_version: 1,
  },
};
const status: AgentStatus = {
  sessionId: agent.id,
  status: "idle",
  source: "appServer",
  observedAtEpochMs: 1,
  plan: {
    source: "codexAppServer",
    explanation: "Keep idle work quiet until requested.",
    steps: [
      { text: "Inspect the idle agent", status: "completed" },
      { text: "Finish the remaining work", status: "pending" },
    ],
    updatedAtEpochMs: 2,
  },
};

function RailHarness() {
  const [selectedSession, setSelectedSession] = useState<Session | undefined>(undefined);
  const shared = {
    selectedSession,
    visibleSessionIds: new Set<string>(),
    statusesById: new Map([[agent.id, status]]),
    reviewReadySessionIds: new Set<string>(),
    menuSessionId: undefined,
    selectSession: (sessionId: string) => setSelectedSession(sessionId === agent.id ? agent : undefined),
    navigateSession: (sessionId: string) => setSelectedSession(sessionId === agent.id ? agent : undefined),
    openSessionMenu: () => {},
    dismissSession: () => {},
    resumeSession: () => {},
    archiveSession: () => {},
  };
  return createElement(ActiveAgentRail, {
    ...shared,
    sessions: [agent],
    projectFolder: "/repo",
    favoriteSessionIds: new Set<string>(),
    taskAttachedSessionIds: new Set<string>(),
    worktreeChangesBySessionId: new Map(),
    toggleFavoriteSession: () => {},
    openTaskChanges: () => {},
    searchOpen: false,
    setSearchOpen: () => {},
  });
}

describe("Active Agent inline todos", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps repeated row clicks as selection and exposes todo detail only from the inline count", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root!.render(createElement(RailHarness)));

    const row = () => container!.querySelector<HTMLButtonElement>(`[data-session-id="${agent.id}"]`);
    const count = () => container!.querySelector<HTMLElement>(".agent-todo-count");
    expect(count()?.textContent).toBe("1/2");
    expect(count()?.title).toContain("Todos · 1/2 complete");
    expect(count()?.title).toContain("✓ Inspect the idle agent");
    expect(count()?.title).toContain("○ Finish the remaining work");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("Finish the remaining work");

    await act(async () => row()?.click());
    expect(row()?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => row()?.click());
    expect(row()?.getAttribute("aria-pressed")).toBe("true");
    expect(row()?.classList.contains("details-expanded")).toBe(false);
    expect(container.querySelector("details")).toBeNull();
    expect(count()?.textContent).toBe("1/2");
  });
});
