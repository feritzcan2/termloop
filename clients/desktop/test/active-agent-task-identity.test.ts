// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { GitHostProjection, Session } from "../src/renderer/model.js";
import { newestPullRequests, pullRequestChip } from "../src/renderer/task-card-copy.js";

type PullRequest = GitHostProjection["matches"][number];

function pullRequest(number: number, state: PullRequest["state"], activity: number, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    provider: "github",
    host: "github.com",
    repository_owner: "apcoa",
    repository_project: null,
    repository_name: "nucleus",
    number,
    title: `PR ${number}`,
    url: `https://github.com/apcoa/nucleus/pull/${number}`,
    state,
    merge_commit_oid: null,
    base_branch: "development",
    head_branch: "feature/anpr",
    head_repository_owner: "apcoa",
    head_repository_project: null,
    head_repository_name: "nucleus",
    check_rollup: "passing",
    check_rollup_source: "githubStatusCheckRollup",
    review_signal: "approved",
    review_signal_source: "githubReviewDecision",
    merge_conflict: "noneDetected",
    merge_conflict_source: "githubMergeable",
    activity_at_epoch_ms: activity,
    activity_at_source: "githubUpdatedAt",
    ...overrides,
  };
}
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
    taskIdentityBySessionId: new Map(sessions.map((session) => [session.id, { taskId: "task-1", issueKey: "UKIE-931", issueUrl: "https://apcoa.atlassian.net/browse/UKIE-931", title: "UK ANPR payment deadline", pullRequests: [] as PullRequest[], morePullRequests: 0 }])),
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

  it("opens the Jira issue from the key without selecting the row", async () => {
    const opened: string[] = [];
    const selected: string[] = [];
    const view = await renderRail([agentSession("lead")], {
      openExternal: (url) => opened.push(url),
      selectSession: (sessionId) => selected.push(sessionId),
    });
    const key = view.container.querySelector<HTMLElement>('[data-session-id="lead"] .row-title-key')!;
    expect(key.title).toBe("Open UKIE-931 in browser");
    await act(async () => key.click());
    expect(opened).toEqual(["https://apcoa.atlassian.net/browse/UKIE-931"]);
    expect(selected).toEqual([]);
    await act(async () => view.container.querySelector<HTMLElement>('[data-session-id="lead"] .row-title')!.click());
    expect(selected).toEqual(["lead"]);
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

  it("lists the newest two pull requests under the change count and opens the one clicked", async () => {
    const projection = { matches: [pullRequest(1, "merged", 10), pullRequest(3, "open", 30), pullRequest(2, "open", 20, { check_rollup: "failing" })] } as GitHostProjection;
    const newest = newestPullRequests(projection, 2);
    expect(newest.map((match) => match.number)).toEqual([3, 2]);
    expect(pullRequestChip(newest[1]!)).toMatchObject({ label: "#2 open", tone: "attention" });
    expect(pullRequestChip(projection.matches[0]!).tone).toBe("done");

    const opened: Array<[string, number]> = [];
    const lead = agentSession("lead");
    const helper = agentSession("helper", { ask_to_source_session_id: "lead" });
    const identity = { taskId: "task-1", issueKey: "UKIE-931", issueUrl: "https://apcoa.atlassian.net/browse/UKIE-931", title: "UK ANPR payment deadline", pullRequests: newest, morePullRequests: 1 };
    const view = await renderRail([lead, helper], {
      taskIdentityBySessionId: new Map([["lead", identity], ["helper", identity]]),
      openTaskPullRequest: (taskId, match) => opened.push([taskId, match.number]),
    });
    const leadRow = view.container.querySelector('[data-session-id="lead"]')!.closest(".active-agent-row")!;
    const chips = [...leadRow.querySelectorAll<HTMLButtonElement>(".active-agent-pull-request")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["#3 open", "#2 open+1"]);
    expect(leadRow.querySelector(".active-agent-worktree-changes")?.textContent).toBe("0 changes");
    await act(async () => chips[1]!.click());
    expect(opened).toEqual([["task-1", 2]]);
    /// The helper row is the same Task; its pull requests are not repeated.
    const helperRow = view.container.querySelector('[data-session-id="helper"]')!.closest(".active-agent-row")!;
    expect(helperRow.querySelector(".active-agent-pull-request")).toBeNull();
    await view.dispose();
  });
});
