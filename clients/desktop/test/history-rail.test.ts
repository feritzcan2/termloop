// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { DeletedSessionDto, SessionHistoryListResult, SessionHistoryPreviewResult } from "@termloop/contract/current";
import type { Session } from "../src/renderer/model.js";
import { HistoryRail, inactiveHistorySessions } from "../src/renderer/ui/HistoryRail.js";

function agent(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project_id: "project-1",
    name: id,
    kind: "Agent",
    lifecycle_state: "exited",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: true,
    closable: true,
    forkable: false,
    ask_to_source_session_id: null,
    fork_source_session_id: null,
    run_configuration_id: null,
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

const externalHistory: SessionHistoryListResult = {
  entries: [{
    history_handle: "a".repeat(64),
    provider: "claude",
    title: "Fix the release pipeline",
    cwd: "/repo/termloop-next",
    branch: "task/history",
    model: "claude-sonnet-4-5",
    updated_at_epoch_ms: 1_700_000_000_000,
    project_match: "exact",
    preview_messages: [
      { role: "user", text: "Find the release failure" },
      { role: "assistant", text: "The packaging target is stale." },
    ],
  }],
  issues: { discovery_unavailable: 0, source_unreadable: 0, source_unrecognized: 0 },
  scanned_at_epoch_ms: 1_700_000_000_100,
  cache_filled: true,
  truncated: false,
};

const termLoopPreview: SessionHistoryPreviewResult = {
  status: "available",
  provider: "codex",
  model: "gpt-5.6-sol",
  updated_at_epoch_ms: 1_700_000_000_000,
  preview_messages: [
    { role: "user", text: "Can you inspect this Agent?" },
    { role: "assistant", text: "The bounded TermLoop preview is ready." },
  ],
};

function externalEntries(count: number): SessionHistoryListResult["entries"] {
  return Array.from({ length: count }, (_, index) => ({
    ...externalHistory.entries[0]!,
    history_handle: index.toString(16).padStart(64, "0"),
    title: `Conversation ${index + 1}`,
    updated_at_epoch_ms: 1_700_000_000_000 - index,
  }));
}

describe("Session History rail", () => {
  it("projects inactive ordinary, Ask-To, and forked TermLoop Agents", () => {
    const stopped = agent("stopped");
    const helper = agent("helper", { ask_to_source_session_id: "stopped" });
    const forked = agent("forked", { fork_source_session_id: "stopped" });
    const values = [
      stopped,
      agent("live", { lifecycle_state: "running" }),
      helper,
      forked,
      agent("worker", { process: { ...stopped.process, template_ref: "builtin.worker.executor" } }),
      agent("improver", { process: { ...stopped.process, template_ref: "builtin.improver.skill" } }),
      agent("run", { run_configuration_id: "dev-server" }),
    ];

    expect(inactiveHistorySessions(values)).toEqual([stopped, helper, forked]);
  });

  it("keeps history compact, expands details on demand, and imports through the opaque intent", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const resumeExternal = vi.fn(async () => undefined);
    const selectSession = vi.fn();
    const loadTermLoopPreview = vi.fn(async () => termLoopPreview);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => {
      root.render(createElement(HistoryRail, {
        projectId: "project-1",
        projectPath: "/repo/termloop-next",
        projectBranch: "task/history",
        currentCwd: "/repo/termloop-next",
        sessions: [
          agent("stopped"),
          agent("ask-to-agent", { ask_to_source_session_id: "stopped" }),
          agent("forked-agent", { fork_source_session_id: "stopped" }),
        ],
        archivedSessions: [],
        deletedSessions: [],
        favoriteSessionIds: new Set<string>(),
        termLoopHistoryLoading: false,
        selectedSessionId: undefined,
        disabled: false,
        load: async () => externalHistory,
        loadTermLoopPreview,
        resumeExternal,
        selectSession,
        resumeSession: () => {},
        restoreArchivedSession: () => {},
        deleteArchivedSession: () => {},
        restoreDeletedSession: () => {},
      }));
    });

    expect(container.textContent).toContain("stopped");
    expect(container.textContent).toContain("Fix the release pipeline");
    expect(container.textContent).toContain("Import & Resume");
    expect(container.querySelector(".history-relationship-label.ask-to")?.textContent).toBe("ASK-TO");
    expect(container.querySelector(".history-relationship-label.fork")?.textContent).toBe("FORK");
    expect(container.textContent).not.toContain("Find the release failure");
    expect(container.innerHTML).not.toContain("transcript");

    const externalToggle = container.querySelector<HTMLButtonElement>('.history-row.external .history-row-main')!;
    expect(externalToggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => externalToggle.click());
    expect(externalToggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Find the release failure");
    expect(container.textContent).toContain("The packaging target is stale.");
    await act(async () => externalToggle.click());
    expect(container.textContent).not.toContain("Find the release failure");

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand stopped"]')!.click());
    expect(selectSession).toHaveBeenCalledWith("stopped");
    expect(loadTermLoopPreview).toHaveBeenCalledWith("project-1", "stopped");
    expect(container.textContent).toContain("The bounded TermLoop preview is ready.");
    expect(container.textContent).not.toContain("/repo/stopped");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Collapse stopped"]')!.click());
    expect(container.textContent).not.toContain("The bounded TermLoop preview is ready.");
    await act(async () => container.querySelector<HTMLButtonElement>(".history-import")?.click());
    expect(resumeExternal).toHaveBeenCalledWith("project-1", "a".repeat(64));

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the rail mounted when the transport returns an invalid envelope", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => {
      root.render(createElement(HistoryRail, {
        projectId: "project-1",
        projectPath: "/repo/termloop-next",
        projectBranch: "task/history",
        currentCwd: "/repo/termloop-next",
        sessions: [],
        archivedSessions: [],
        deletedSessions: [],
        favoriteSessionIds: new Set<string>(),
        termLoopHistoryLoading: false,
        selectedSessionId: undefined,
        disabled: false,
        load: async () => ({ ok: true, result: externalHistory }) as unknown as SessionHistoryListResult,
        loadTermLoopPreview: async () => ({ ...termLoopPreview, status: "unavailable" as const, model: null, updated_at_epoch_ms: null, preview_messages: [] }),
        resumeExternal: async () => undefined,
        selectSession: () => {},
        resumeSession: () => {},
        restoreArchivedSession: () => {},
        deleteArchivedSession: () => {},
        restoreDeletedSession: () => {},
      }));
    });

    expect(container.querySelector('[aria-label="Session History"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Session history response is invalid.");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows the recent page before filling the 100-item cache and reveals 20 at a time", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const recent = { ...externalHistory, entries: externalEntries(20), cache_filled: false, truncated: true };
    const filled = { ...externalHistory, entries: externalEntries(45), cache_filled: true };
    let resolveFilled!: (result: SessionHistoryListResult) => void;
    const fillPromise = new Promise<SessionHistoryListResult>((resolve) => { resolveFilled = resolve; });
    const load = vi.fn((_projectId: string, _force = false, fillCache = false) => (
      fillCache ? fillPromise : Promise.resolve(recent)
    ));
    const loadTermLoopPreview = vi.fn()
      .mockResolvedValueOnce({ ...termLoopPreview, status: "unavailable" as const, model: null, updated_at_epoch_ms: null, preview_messages: [] })
      .mockResolvedValueOnce(termLoopPreview);

    await act(async () => {
      root.render(createElement(HistoryRail, {
        projectId: "project-1",
        projectPath: "/repo/termloop-next",
        projectBranch: "task/history",
        currentCwd: "/repo/termloop-next",
        sessions: [agent("recent-managed")],
        archivedSessions: [],
        deletedSessions: [],
        favoriteSessionIds: new Set<string>(),
        termLoopHistoryLoading: false,
        selectedSessionId: undefined,
        disabled: false,
        load,
        loadTermLoopPreview,
        resumeExternal: async () => undefined,
        selectSession: () => {},
        resumeSession: () => {},
        restoreArchivedSession: () => {},
        deleteArchivedSession: () => {},
        restoreDeletedSession: () => {},
      }));
      await Promise.resolve();
    });

    expect(container.querySelectorAll(".history-row.external")).toHaveLength(20);
    expect(container.textContent).toContain("Caching older conversations…");
    expect(load).toHaveBeenNthCalledWith(1, "project-1", false, false);
    expect(load).toHaveBeenNthCalledWith(2, "project-1", false, true);

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand recent-managed"]')!.click());
    expect(loadTermLoopPreview).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Loading conversation preview…");

    await act(async () => { resolveFilled(filled); await fillPromise; });
    expect(loadTermLoopPreview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("The bounded TermLoop preview is ready.");
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(20);
    const more = container.querySelector<HTMLButtonElement>(".history-more");
    expect(more?.textContent).toBe("Show 20 older");
    await act(async () => more?.click());
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(40);
    await act(async () => container.querySelector<HTMLButtonElement>(".history-more")?.click());
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(45);

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("filters cached history by search, source, external time, and current location", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const now = Date.now();
    const entries: SessionHistoryListResult["entries"] = [
      {
        ...externalHistory.entries[0]!,
        history_handle: "1".repeat(64),
        title: "Current release work",
        cwd: "/repo/termloop-next",
        branch: "main",
        updated_at_epoch_ms: now,
        preview_messages: [{ role: "user", text: "preview-only needle" }],
      },
      {
        ...externalHistory.entries[0]!,
        history_handle: "2".repeat(64),
        provider: "codex",
        title: "History implementation",
        cwd: "/repo/worktrees/history",
        branch: "task/history",
        updated_at_epoch_ms: now - 3 * 24 * 60 * 60 * 1_000,
      },
      {
        ...externalHistory.entries[0]!,
        history_handle: "3".repeat(64),
        title: "Older main worktree",
        cwd: "/repo/worktrees/old",
        branch: "main",
        updated_at_epoch_ms: now - 10 * 24 * 60 * 60 * 1_000,
      },
      {
        ...externalHistory.entries[0]!,
        history_handle: "4".repeat(64),
        provider: "codex",
        title: "Legacy project root",
        cwd: "/repo/termloop-next",
        branch: "legacy",
        updated_at_epoch_ms: now - 40 * 24 * 60 * 60 * 1_000,
      },
    ];
    const filteredHistory = { ...externalHistory, entries };

    await act(async () => {
      root.render(createElement(HistoryRail, {
        projectId: "project-1",
        projectPath: "/repo/termloop-next",
        projectBranch: "main",
        currentCwd: "/repo/worktrees/history",
        sessions: [agent("termloop", { process: { ...agent("termloop").process, cwd: "/repo/worktrees/history" } })],
        archivedSessions: [],
        deletedSessions: [],
        favoriteSessionIds: new Set<string>(),
        termLoopHistoryLoading: false,
        selectedSessionId: undefined,
        disabled: false,
        load: async () => filteredHistory,
        loadTermLoopPreview: async () => termLoopPreview,
        resumeExternal: async () => undefined,
        selectSession: () => {},
        resumeSession: () => {},
        restoreArchivedSession: () => {},
        deleteArchivedSession: () => {},
        restoreDeletedSession: () => {},
      }));
    });

    const change = async (label: string, value: string) => {
      const control = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      await act(async () => {
        control.value = value;
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search Session History"]')!;
    const typeSearch = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, value);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await typeSearch("preview-only needle");
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(1);
    expect(container.textContent).toContain("Current release work");

    await typeSearch("");
    await change("Filter Session History by source", "codex");
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(2);
    expect(container.querySelector("#termloop-history-label")).toBeNull();

    await change("Filter Session History by source", "all");
    await change("Filter Session History by time", "7d");
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(2);
    expect(container.textContent).toContain("No matching TermLoop Sessions.");

    await change("Filter Session History by time", "all");
    await change("Filter Session History by location", "project");
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(2);

    await change("Filter Session History by location", "branch");
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(2);
    expect(container.querySelectorAll(".history-section:first-of-type .history-row")).toHaveLength(0);

    await change("Filter Session History by location", "cwd");
    expect(container.querySelectorAll(".history-row.external")).toHaveLength(1);
    expect(container.textContent).toContain("termloop");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("filters favorited, archived, and deleted Agents inside TermLoop history", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const restoreArchivedSession = vi.fn();
    const deleteArchivedSession = vi.fn();
    const restoreDeletedSession = vi.fn();
    const loadTermLoopPreview = vi.fn(async () => termLoopPreview);
    const archived = agent("archived", { archived_at_epoch_ms: Date.now(), ask_to_source_session_id: "source" });
    const deletedAgent = agent("deleted", { fork_source_session_id: "source" });
    const deleted: DeletedSessionDto = {
      session: deletedAgent,
      deleted_at_epoch_ms: Date.now(),
      purge_at_epoch_ms: Date.now() + 30 * 24 * 60 * 60 * 1_000,
      source_available: true,
      restore_blocker: null,
    };

    await act(async () => {
      root.render(createElement(HistoryRail, {
        projectId: "project-1",
        projectPath: "/repo/termloop-next",
        projectBranch: "main",
        currentCwd: "/repo/termloop-next",
        sessions: [agent("ordinary")],
        archivedSessions: [archived],
        deletedSessions: [deleted],
        favoriteSessionIds: new Set([archived.id, deletedAgent.id]),
        termLoopHistoryLoading: false,
        selectedSessionId: undefined,
        disabled: false,
        load: async () => externalHistory,
        loadTermLoopPreview,
        resumeExternal: async () => undefined,
        selectSession: () => {},
        resumeSession: () => {},
        restoreArchivedSession,
        deleteArchivedSession,
        restoreDeletedSession,
      }));
    });

    const source = container.querySelector<HTMLSelectElement>('[aria-label="Filter Session History by source"]')!;
    const location = container.querySelector<HTMLSelectElement>('[aria-label="Filter Session History by location"]')!;
    await act(async () => {
      location.value = "branch";
      location.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      source.value = "termloop";
      source.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(location.value).toBe("all");
    expect(container.querySelector("#external-history-label")).toBeNull();
    expect(container.textContent).toContain("archived");
    expect(container.textContent).toContain("deleted");
    expect(container.querySelectorAll(".history-section .history-row")).toHaveLength(3);
    expect(container.querySelector(".history-row.archived .history-relationship-label.ask-to")?.textContent).toBe("ASK-TO");
    expect(container.querySelector(".history-row.deleted .history-relationship-label.fork")?.textContent).toBe("FORK");

    const state = container.querySelector<HTMLSelectElement>('[aria-label="Filter Session History by state"]')!;
    await act(async () => {
      state.value = "favorited";
      state.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(source.value).toBe("termloop");
    expect(container.querySelectorAll(".history-section .history-row")).toHaveLength(2);
    expect(container.querySelectorAll(".history-row.archived")).toHaveLength(1);
    expect(container.querySelectorAll(".history-row.deleted")).toHaveLength(1);
    expect(container.textContent).not.toContain("ordinary");

    await act(async () => {
      state.value = "archived";
      state.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(source.value).toBe("termloop");
    expect(container.querySelectorAll(".history-row.archived")).toHaveLength(1);
    expect(container.querySelectorAll(".history-row.deleted")).toHaveLength(0);
    expect(container.textContent).not.toContain("The bounded TermLoop preview is ready.");

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand archived"]')!.click());
    expect(loadTermLoopPreview).toHaveBeenCalledWith("project-1", "archived");
    expect(container.textContent).toContain("The bounded TermLoop preview is ready.");
    await act(async () => container.querySelector<HTMLButtonElement>(".history-row.archived .history-action")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete archived Agent archived"]')!.click());
    await act(async () => {
      state.value = "deleted";
      state.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelectorAll(".history-row.archived")).toHaveLength(0);
    expect(container.querySelectorAll(".history-row.deleted")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".history-row.deleted .history-action")!.click());
    expect(restoreArchivedSession).toHaveBeenCalledWith("archived");
    expect(deleteArchivedSession).toHaveBeenCalledWith("archived");
    expect(restoreDeletedSession).toHaveBeenCalledWith("deleted");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
