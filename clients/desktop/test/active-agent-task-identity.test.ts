// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { ActiveAgentRail, type ActiveAgentRailProps } from "../src/renderer/ui/ActiveAgentRail.js";

function agentSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project_id: "project-1",
    name: null,
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
      program: "/usr/local/bin/claude",
      args: [],
      cwd: "/repo/feature-uk-anpr-payment-deadline",
      agent_id: "claude",
      template_ref: "builtin.agent.interactive",
      template_version: 1,
    },
    ...overrides,
  };
}

async function renderRail(sessions: Session[], overrides: Partial<ActiveAgentRailProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(ActiveAgentRail, {
    sessions,
    projectFolder: "/repo",
    selectedSession: undefined,
    visibleSessionIds: new Set<string>(),
    statusesById: new Map(),
    reviewReadySessionIds: new Set<string>(),
    favoriteSessionIds: new Set<string>(),
    taskAttachedSessionIds: new Set(sessions.map((session) => session.id)),
    worktreeChangesBySessionId: new Map(sessions.map((session) => [session.id, { taskId: "task-1", taskTitle: "UK ANPR", changeCount: 0 }])),
    taskIdentityBySessionId: new Map(sessions.map((session) => [session.id, { issueKey: "UKIE-931", title: "UK ANPR payment deadline" }])),
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
    ...overrides,
  })));
  return {
    container,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("Active Agent rows inside a Task", () => {
  it("title the row by the Task key and title and keep zero changes visible", async () => {
    const view = await renderRail([agentSession("lead")]);
    const row = view.container.querySelector<HTMLButtonElement>('[data-session-id="lead"]')!;
    expect(row.querySelector(".row-title-key")?.textContent).toBe("UKIE-931");
    expect(row.querySelector(".row-title")?.textContent).toBe("UKIE-931UK ANPR payment deadline");
    /// The provider moves to the state line and the folder is not repeated.
    expect(row.querySelector(".row-agent")?.textContent).toBe("Claude");
    expect(row.querySelector(".row-subtitle")).toBeNull();
    expect(row.getAttribute("aria-label")).toContain("UKIE-931 UK ANPR payment deadline");
    expect(view.container.querySelector(".active-agent-worktree-changes")?.textContent).toBe("0 changes");
    await view.dispose();
  });

  it("keeps a user-given Session name and an Ask-To helper's own name", async () => {
    const named = agentSession("named", { name: "Payments lead" });
    const lead = agentSession("lead");
    const helper = agentSession("helper", {
      ask_to_source_session_id: "lead",
      process: { ...lead.process, program: "/usr/local/bin/codex", agent_id: "codex" },
    });
    const view = await renderRail([named, lead, helper]);
    expect(view.container.querySelector('[data-session-id="named"] .row-title')?.textContent).toBe("Payments lead");
    expect(view.container.querySelector('[data-session-id="helper"] .row-title')?.textContent).toBe("Codex");
    expect(view.container.querySelector('[data-session-id="helper"] .row-subtitle')).toBeNull();
    await view.dispose();
  });
});
