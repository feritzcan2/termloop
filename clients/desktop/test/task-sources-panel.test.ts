// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectTaskAutomationConfigurationDto,
  TaskSourceCandidateDto,
  TaskSourceDto,
} from "@termloop/contract/current";
import { TaskSourcesPanel, type TaskSourceActions } from "../src/renderer/ui/TaskSourcesPanel.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";
import { candidate, source } from "./task-sources.test.js";

/// Statuses belong to the boards that were asked for: adding Operations retires
/// "Done", which is how a board change can strand a status selection.
const statusesFor = (boardIds: readonly string[]) => boardIds.includes("91")
  ? [{ id: "1", name: "Open" }, { id: "3", name: "In Progress" }]
  : [{ id: "1", name: "Open" }, { id: "3", name: "In Progress" }, { id: "5", name: "Done" }];

type PanelState = {
  sources: TaskSourceDto[];
  candidates: TaskSourceCandidateDto[];
  automation?: ProjectTaskAutomationConfigurationDto;
};

function actions(state: PanelState): TaskSourceActions & { calls: string[] } {
  const calls: string[] = [];
  const automation = () => state.automation ?? {
    projectId: "project-1",
    createWorktree: false,
    worktreePrefix: "termloop",
    agentId: null,
    model: null,
    permission: null,
    reasoning: null,
    kickoffMessage: null,
  };
  return {
    calls,
    list: async () => { calls.push("list"); return { sources: state.sources, stateRevision: 9, observationSequence: 7 }; },
    getProjectAutomation: async (projectId) => {
      calls.push(`automationGet:${projectId}`);
      return { configuration: automation(), stateRevision: 4 };
    },
    setProjectAutomation: async (params) => {
      calls.push(`automationSet:${params.projectId}:${params.createWorktree}:${params.worktreePrefix}:${params.agentId ?? "-"}:${params.model ?? "-"}:${params.permission ?? "-"}:${params.reasoning ?? "-"}:${params.kickoffMessage ? "message" : "-"}:${params.expectedRevision}`);
      state.automation = {
        projectId: params.projectId,
        createWorktree: params.createWorktree,
        worktreePrefix: params.worktreePrefix,
        agentId: params.agentId,
        model: params.model,
        permission: params.permission,
        reasoning: params.reasoning,
        kickoffMessage: params.kickoffMessage,
      };
      return { configuration: state.automation, stateRevision: params.expectedRevision + 1 };
    },
    listBoards: async (params) => {
      // Deliberately omit the token from the trace: secrets must not enter
      // diagnostics even in test helpers.
      calls.push(`boards:${params.siteBaseUrl}:${params.email}:${params.boardId ?? "all"}`);
      const boards = [
        { id: "84", name: "Payments", kind: "scrum", locationName: "Money" },
        { id: "91", name: "Operations", kind: "kanban", locationName: null },
        { id: "310", name: "UK & IE Flow Next", kind: "scrum", locationName: "UK & IE Flow Next (UKIE)" },
      ];
      return {
        boards: params.boardId ? boards.filter((board) => board.id === params.boardId) : boards.slice(0, 2),
        truncated: false,
        failureReason: null,
      };
    },
    listStoredBoards: async (params) => {
      calls.push(`storedBoards:${params.sourceId}:${params.siteBaseUrl}:${params.expectedGeneration}:${params.boardId ?? "all"}`);
      const boards = [
        { id: "84", name: "Payments", kind: "scrum", locationName: "Money" },
        { id: "91", name: "Operations", kind: "kanban", locationName: null },
        { id: "310", name: "UK & IE Flow Next", kind: "scrum", locationName: "UK & IE Flow Next (UKIE)" },
      ];
      return {
        boards: params.boardId ? boards.filter((board) => board.id === params.boardId) : boards.slice(0, 2),
        truncated: false,
        failureReason: null,
      };
    },
    listStatuses: async (params) => {
      calls.push(`statuses:${params.siteBaseUrl}:${params.email}:${params.boardIds.join("|")}`);
      return { statuses: statusesFor(params.boardIds), failureReason: null };
    },
    listStoredStatuses: async (params) => {
      calls.push(`storedStatuses:${params.sourceId}:${params.siteBaseUrl}:${params.expectedGeneration}:${params.boardIds.join("|")}`);
      return { statuses: statusesFor(params.boardIds), failureReason: null };
    },
    create: async (params) => {
      const boards = params.boards.map((board) => `${board.id}=${board.name}`).join("|") || "-";
      calls.push(`create:${params.name}:${params.siteBaseUrl}:${params.scopeKind}:${boards}:${params.jql}:${params.importPolicy}:${params.autoImportActiveTaskLimit}:${params.refreshIntervalSeconds}:${params.expectedRevision}`);
      const created = source({
        id: "created",
        name: params.name,
        generation: 1,
        credentialState: "none",
        lastSuccessfulAtEpochMs: null,
        candidateCount: 0,
        scopeKind: params.scopeKind,
        boards: params.boards,
        statuses: params.statuses,
        jql: params.jql,
        importPolicy: params.importPolicy,
        autoImportActiveTaskLimit: params.autoImportActiveTaskLimit,
      });
      state.sources = [...state.sources, created];
      return { source: created, stateRevision: 10 };
    },
    update: async (params) => {
      calls.push(`update:${params.sourceId}:${params.enabled}:${params.expectedGeneration}:${params.expectedRevision}`);
      const boards = params.boards.map((board) => `${board.id}=${board.name}`).join("|") || "-";
      calls.push(`updateScope:${params.scopeKind}:${boards}:${params.jql}`);
      calls.push(`updateIntake:${params.importPolicy}`);
      calls.push(`updateAutoImportLimit:${params.autoImportActiveTaskLimit}`);
      const current = state.sources.find((source) => source.id === params.sourceId)!;
      const updated = {
        ...current,
        name: params.name,
        enabled: params.enabled,
        generation: params.expectedGeneration + 1,
        siteBaseUrl: params.siteBaseUrl,
        scopeKind: params.scopeKind,
        boards: params.boards,
        statuses: params.statuses,
        jql: params.jql,
        importPolicy: params.importPolicy,
        autoImportActiveTaskLimit: params.autoImportActiveTaskLimit,
        refreshIntervalSeconds: params.refreshIntervalSeconds,
      };
      state.sources = state.sources.map((source) => source.id === params.sourceId ? updated : source);
      return { source: updated, stateRevision: 10 };
    },
    setCredentials: async (params) => { calls.push(`credentials:${params.sourceId}:${params.email}:${params.expectedGeneration}`); return { sourceId: params.sourceId, credentialState: "present" }; },
    delete: async (params) => { calls.push(`delete:${params.sourceId}`); state.sources = state.sources.filter((row) => row.id !== params.sourceId); return { sourceId: params.sourceId, deleted: true, stateRevision: 11 }; },
    refresh: async (params) => { calls.push(`refresh:${params.sourceId}:${params.expectedGeneration}`); return { sourceId: params.sourceId, refreshed: true, failureReason: null, candidateCount: 2, truncated: true, observationSequence: 8 }; },
    listCandidates: async (sourceId) => { calls.push(`candidates:${sourceId}`); return { sourceId, candidates: state.candidates, lastSuccessfulAtEpochMs: 1_000_000, stateRevision: 10, observationSequence: 7 }; },
    importCandidate: async (params) => {
      calls.push(`import:${params.externalId}:${params.expectedGeneration}:${params.expectedObservationSequence}:${params.expectedRevision}:${params.worktreeIntent}:${params.worktreePrefix ?? "-"}:${params.agentId ?? "-"}:${params.model ?? "-"}:${params.permission ?? "-"}:${params.reasoning ?? "-"}:${params.kickoffMessage ? "message" : "-"}`);
      state.candidates = state.candidates.map((row) => row.externalId === params.externalId ? { ...row, state: "added", taskId: "task-9" } : row);
      return { task: { id: "task-9", title: "Fix login" } as never, stateRevision: 12 };
    },
    ignoreCandidate: async (params) => { calls.push(`ignore:${params.externalId}`); return { candidate: state.candidates[0]!, sourceGeneration: 3, stateRevision: 12 }; },
    unignoreCandidate: async (params) => { calls.push(`unignore:${params.externalId}`); return { candidate: state.candidates[0]!, sourceGeneration: 3, stateRevision: 12 }; },
  };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("Task Sources panel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function render(api: TaskSourceActions, extra: Partial<Parameters<typeof TaskSourcesPanel>[0]> = {}) {
    return act(async () => root.render(createElement(TaskSourcesPanel, {
      projectId: "project-1",
      projectName: "TermLoop",
      refreshToken: 0,
      actions: api,
      agentCapabilities: [],
      openTask: vi.fn(),
      openExternal: vi.fn(async () => undefined),
      close: vi.fn(),
      now: () => 1_000_000 + 5 * 60_000,
      ...extra,
    })));
  }

  function renderStrict(api: TaskSourceActions, extra: Partial<Parameters<typeof TaskSourcesPanel>[0]> = {}) {
    return act(async () => root.render(createElement(StrictMode, null, createElement(TaskSourcesPanel, {
      projectId: "project-1",
      projectName: "TermLoop",
      refreshToken: 0,
      actions: api,
      agentCapabilities: [],
      openTask: vi.fn(),
      openExternal: vi.fn(async () => undefined),
      close: vi.fn(),
      now: () => 1_000_000 + 5 * 60_000,
      ...extra,
    }))));
  }

  it("shows an empty state with the connect offer and never lists a token", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api);
    await flush();
    expect(host.textContent).toContain("No Task Sources yet");
    expect(api.calls).toEqual(["list", "automationGet:project-1"]);
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it("keeps async list and mutation results live across the development StrictMode effect cycle", async () => {
    const api = actions({ sources: [], candidates: [] });
    api.create = async () => { throw new Error("state revision changed; refresh and try again"); };
    await renderStrict(api);
    await flush();
    expect(host.textContent).toContain("No Task Sources yet");
    expect(host.textContent).not.toContain("Loading Task Sources");
    await openConnect();
    await setInput("task-source-new-url", "https://acme.atlassian.net/browse/ABC-1");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await submitForm();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The source was not created: state revision changed");
    const submit = [...host.querySelectorAll("button")].find((button) => button.textContent === "Connect and refresh") as HTMLButtonElement;
    expect(submit).toBeDefined();
    expect(host.textContent).not.toContain("Connecting…");
  });

  it("does not open Connect until the initial list revision is loaded", async () => {
    const api = actions({ sources: [], candidates: [] });
    let resolveList!: (result: Awaited<ReturnType<TaskSourceActions["list"]>>) => void;
    api.list = () => new Promise((resolve) => { resolveList = resolve; });
    await render(api);
    // Nothing offers Connect while the revision a create would carry is unknown.
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Add Jira source"))).toBe(false);
    expect(host.querySelector('form[aria-label="Connect Jira"]')).toBeNull();
    await act(async () => resolveList({ sources: [], stateRevision: 9, observationSequence: 7 }));
    await flush();
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Jira source")) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    await act(async () => { add.click(); });
    expect(host.querySelector('form[aria-label="Connect Jira"]')).not.toBeNull();
  });

  it("lists sources with health, selects the first, and loads its review queue", async () => {
    const api = actions({
      sources: [source(), source({ id: "source-2", name: "Broken", runtimeState: "attention", failureReason: "credentialsInvalid" })],
      candidates: [candidate(), candidate({ externalId: "2", key: "ACME-2", state: "added", taskId: "task-2" }), candidate({ externalId: "3", key: "ACME-3", state: "noLongerMatches" }), candidate({ externalId: "4", key: "ACME-4", state: "possibleDuplicate", taskId: "task-4" })],
    });
    const openTask = vi.fn();
    await render(api, { openTask });
    await flush();
    expect(api.calls.filter((call) => !call.startsWith("automationGet"))).toEqual(["list", "candidates:source-1"]);
    expect(api.calls).toContain("automationGet:project-1");
    // The rail carries health as a tone dot and its title; the selected source
    // spells it out once, with the failure detail, in the detail pane.
    expect(host.querySelector('[data-source-id="source-1"] .task-source-dot')?.className).toContain("tone-ok");
    expect(host.querySelector('[data-source-id="source-1"] .task-source-rail-select')?.getAttribute("title")).toContain("Synced 5 min ago");
    expect(host.querySelector('[data-source-id="source-2"] .task-source-dot')?.className).toContain("tone-attention");
    expect(host.querySelector(".task-source-detail-pane")?.textContent).toContain("Synced 5 min ago");
    await act(async () => { (host.querySelector('[data-source-id="source-2"] .task-source-rail-select') as HTMLButtonElement).click(); });
    await flush();
    expect(host.querySelector(".task-source-detail-pane")?.textContent).toContain("Credentials rejected");
    expect(host.querySelector(".task-source-failure")?.textContent).toMatch(/Replace the credentials/);
    await act(async () => { (host.querySelector('[data-source-id="source-1"] .task-source-rail-select') as HTMLButtonElement).click(); });
    await flush();
    // Default filter shows only review work.
    expect([...host.querySelectorAll("[data-candidate-key]")].map((row) => row.getAttribute("data-candidate-key"))).toEqual(["ACME-1", "ACME-4"]);
    await act(async () => { (host.querySelector('[role="tab"][aria-selected="false"]') as HTMLButtonElement).click(); });
    expect([...host.querySelectorAll("[data-candidate-key]")].map((row) => row.getAttribute("data-candidate-key"))).toEqual(["ACME-1", "ACME-2", "ACME-3", "ACME-4"]);
    const added = host.querySelector('[data-candidate-key="ACME-2"]')!;
    expect(added.querySelector("button.primary-button")).toBeNull();
    await act(async () => { ([...added.querySelectorAll("button")].find((button) => button.textContent === "Open Task") as HTMLButtonElement).click(); });
    expect(openTask).toHaveBeenCalledWith("task-2");
    const gone = host.querySelector('[data-candidate-key="ACME-3"]')!;
    expect(gone.textContent).toContain("Left the scope");
    expect([...gone.querySelectorAll("button")].map((button) => button.textContent)).not.toContain("Import as Task");
  });

  it("states the Task rule once above the sources and saves the edited launch profile", async () => {
    const api = actions({ sources: [source({ name: "Example Jira" })], candidates: [] });
    await render(api, { agentCapabilities: [fullAgentCapability("codex")] });
    await flush();

    // One page: the rule reads as a sentence and is not a second destination.
    const bar = host.querySelector('section[aria-label="New Task defaults"]') as HTMLElement;
    expect(bar.querySelector('[data-testid="project-task-automation-summary"]')?.textContent)
      .toBe("Task only — no worktree, no agent");
    expect(host.textContent).not.toContain("Task settings");
    expect(bar.querySelector("#project-task-automation-worktree")).toBeNull();

    await act(async () => { (bar.querySelector("button") as HTMLButtonElement).click(); });
    const worktree = bar.querySelector("#project-task-automation-worktree") as HTMLInputElement;
    await act(async () => { worktree.click(); });
    await act(async () => {
      ([...bar.querySelectorAll("button")].find((button) => button.textContent === "Save defaults") as HTMLButtonElement).click();
    });
    await flush();

    // Saved as one explicit profile against the revision the page read.
    expect(api.calls).toContain("automationSet:project-1:true:termloop:-:-:-:-:-:4");
    expect(host.querySelector('[data-testid="project-task-automation-summary"]')?.textContent)
      .toBe("Task and worktree — no agent");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).not.toContain("Save defaults");
  });

  it("keeps the launch-profile editor and its choices visible after a rejected save", async () => {
    const api = actions({ sources: [source()], candidates: [] });
    api.setProjectAutomation = async () => { throw new Error("state revision changed; try again"); };
    await render(api, { agentCapabilities: [fullAgentCapability("codex")] });
    await flush();

    const bar = host.querySelector('section[aria-label="New Task defaults"]') as HTMLElement;
    await act(async () => { (bar.querySelector("button") as HTMLButtonElement).click(); });
    await act(async () => { (bar.querySelector("#project-task-automation-worktree") as HTMLInputElement).click(); });
    await act(async () => {
      ([...bar.querySelectorAll("button")].find((button) => button.textContent === "Save defaults") as HTMLButtonElement).click();
    });
    await flush();

    expect(bar.querySelector('[role="alert"]')?.textContent).toContain("state revision changed");
    expect((bar.querySelector("#project-task-automation-worktree") as HTMLInputElement).checked).toBe(true);
    expect([...bar.querySelectorAll("button")].some((button) => button.textContent === "Save defaults")).toBe(true);
  });

  it("shows source automatic import settings and refreshes after saving an active Task limit", async () => {
    const api = actions({ sources: [source({ name: "Example Jira" })], candidates: [] });
    await render(api);
    await flush();

    const settings = host.querySelector('section[aria-label="Automatic import settings"]') as HTMLElement;
    expect(settings.textContent).toContain("Off · review first");
    expect(settings.textContent).toContain("stay in the review queue");

    await setInput("task-source-intake-policy-source-1", "autoAdd");
    expect((settings.querySelector("#task-source-intake-limit-source-1") as HTMLInputElement).value).toBe("5");
    await setInput("task-source-intake-limit-source-1", "4");
    expect(settings.textContent).toContain("fewer than 4 open, unarchived Tasks");
    await act(async () => {
      ([...settings.querySelectorAll("button")].find((button) => button.textContent === "Save automation") as HTMLButtonElement).click();
    });
    await flush();
    await flush();

    expect(api.calls).toContain("updateIntake:autoAdd");
    expect(api.calls).toContain("updateAutoImportLimit:4");
    expect(api.calls).toContain("refresh:source-1:4");
    expect(host.querySelector('[data-source-id="source-1"] .task-source-rail-meta')?.textContent)
      .toBe("Auto-import · 4 active max");
    expect(host.textContent).toContain("will keep up to 4 active Tasks and was refreshed now");
  });

  it("confirms the worktree and agent for one import, prefilled from the Project default, and blocks a second mutation while busy", async () => {
    const api = actions({
      sources: [source()],
      candidates: [candidate(), candidate({ externalId: "2", key: "ACME-2" })],
      automation: {
        projectId: "project-1",
        createWorktree: true,
        worktreePrefix: "termloop",
        agentId: "codex",
        model: "gpt-5.6-sol",
        permission: "bypassPermissions",
        reasoning: "high",
        kickoffMessage: "Implement and verify this Task.",
      },
    });
    const inner = api.importCandidate;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.importCandidate = async (params) => { await gate; return inner(params); };
    await render(api, { agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")] });
    await flush();

    const importButtons = [...host.querySelectorAll("button")].filter((button) => button.textContent === "Import as Task");
    expect(importButtons).toHaveLength(2);
    // Pressing Import only opens the confirmation; nothing is created yet.
    await act(async () => { importButtons[0]!.click(); });
    expect(api.calls.some((call) => call.startsWith("import:"))).toBe(false);
    const options = host.querySelector('[aria-label="Import ACME-1 as Task"]') as HTMLElement;
    expect(options).not.toBeNull();
    expect((options.querySelector("#task-candidate-import-worktree") as HTMLInputElement).checked).toBe(true);
    expect((options.querySelector("#task-candidate-import-start-agent") as HTMLInputElement).checked).toBe(true);
    expect((options.querySelector("#task-candidate-import-worktree-prefix") as HTMLInputElement).value).toBe("termloop");
    expect((options.querySelector("#task-candidate-import-agent") as HTMLSelectElement).value).toBe("codex");
    expect((options.querySelector("#task-candidate-import-model") as HTMLSelectElement).value).toBe("gpt-5.6-sol");
    expect((options.querySelector("#task-candidate-import-permission") as HTMLSelectElement).value).toBe("bypassPermissions");
    expect((options.querySelector("#task-candidate-import-reasoning") as HTMLSelectElement).value).toBe("high");
    expect((options.querySelector("#task-candidate-import-kickoff-message") as HTMLTextAreaElement).value)
      .toBe("Implement and verify this Task.");

    // The one-shot choice overrides the Project default for this import only.
    await setInput("task-candidate-import-worktree-prefix", "feature");
    await setInput("task-candidate-import-agent", "claude");
    expect(host.querySelector('[data-testid="task-candidate-import-summary"]')?.textContent).toContain("Claude");

    const confirm = [...options.querySelectorAll("button")].find((button) => button.textContent === "Create Task") as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    // While the import is in flight every other mutation is disabled and a
    // second click cannot start another command.
    expect([...host.querySelectorAll("button.primary-button")].every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => { importButtons[1]!.click(); });
    expect(host.textContent).toContain("Importing…");
    await act(async () => { release(); });
    await flush();
    await flush();

    expect(api.calls.filter((call) => call.startsWith("import:"))).toEqual([
      "import:10001:3:7:10:provision:feature:claude:default:default:default:message",
    ]);
    expect(host.textContent).toContain("ACME-1 is now Task “Fix login”");
    expect(host.querySelector('[aria-label="Import ACME-1 as Task"]')).toBeNull();
  });

  it("sends an explicit none when the confirmation clears the worktree, and sends nothing when it is cancelled", async () => {
    const api = actions({
      sources: [source()],
      candidates: [candidate(), candidate({ externalId: "2", key: "ACME-2" })],
      automation: {
        projectId: "project-1",
        createWorktree: true,
        worktreePrefix: "termloop",
        agentId: "codex",
        model: "gpt-5.6-sol",
        permission: "bypassPermissions",
        reasoning: "high",
        kickoffMessage: "Implement and verify this Task.",
      },
    });
    await render(api, { agentCapabilities: [fullAgentCapability("codex")] });
    await flush();

    const openConfirmation = async (key: string) => act(async () => {
      ([...host.querySelectorAll(`[data-candidate-key="${key}"] button`)]
        .find((button) => button.textContent === "Import as Task") as HTMLButtonElement).click();
    });
    await openConfirmation("ACME-1");
    await act(async () => { (host.querySelector("#task-candidate-import-start-agent") as HTMLInputElement).click(); });
    await act(async () => { (host.querySelector("#task-candidate-import-worktree") as HTMLInputElement).click(); });
    expect(host.querySelector('[data-testid="task-candidate-import-summary"]')?.textContent).toContain("Task only");
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Create Task") as HTMLButtonElement).click();
    });
    await flush();
    await flush();
    expect(api.calls.filter((call) => call.startsWith("import:"))).toEqual(["import:10001:3:7:10:none:-:-:-:-:-:-"]);

    // Cancel closes the confirmation without a second command.
    api.calls.length = 0;
    await openConfirmation("ACME-2");
    await act(async () => {
      ([...host.querySelectorAll(".task-candidate-import-options button")].find((button) => button.textContent === "Cancel") as HTMLButtonElement).click();
    });
    expect(host.querySelector(".task-candidate-import-options")).toBeNull();
    expect(api.calls.filter((call) => call.startsWith("import:"))).toEqual([]);
  });

  it("keeps the source form's intake to review versus automatic and stores it on create", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api, { agentCapabilities: [fullAgentCapability("codex")] });
    await flush();
    await openConnect();
    const form = host.querySelector('form[aria-label="Connect Jira"]') as HTMLFormElement;
    // The source form owns intake only; worktree and agent are Project-level.
    expect(form.querySelector("#task-source-new-worktree")).toBeNull();
    expect(form.querySelector("#task-source-new-agent")).toBeNull();
    expect(form.textContent).not.toContain("When Jira issues arrive");
    // The connect form is a flat sequence of questions, not a stack of cards.
    expect(form.querySelectorAll("h4")).toHaveLength(0);
    expect([...form.querySelectorAll(":scope > label")].map((label) => label.textContent)).toEqual([
      "Jira site or issue link",
      "Atlassian account email",
      "API token",
      "Which issues",
      "When an issue matches",
    ]);
    expect((form.querySelector("#task-source-new-import-policy") as HTMLSelectElement).value).toBe("review");
    await setInput("task-source-new-import-policy", "autoAdd");
    expect((form.querySelector("#task-source-new-auto-import-limit") as HTMLInputElement).value).toBe("5");
    expect(form.textContent).toContain("active Tasks");
    expect(form.textContent).toContain("next refresh can import another");
    await setInput("task-source-new-auto-import-limit", "7");
    await setInput("task-source-new-url", "https://acme.atlassian.net");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await submitForm();
    expect(api.calls.filter((call) => call.startsWith("create:"))).toEqual([
      "create:Acme Jira:https://acme.atlassian.net:assignedToMe:-:null:autoAdd:7:900:9",
    ]);
  });

  const setInput = (id: string, value: string) => act(async () => {
    const input = host.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  const setBoardChecked = (id: string, checked: boolean) => act(async () => {
    const input = host.querySelector(`.task-source-board-option input[value="${id}"]`) as HTMLInputElement;
    if (input.checked !== checked) input.click();
  });
  const openConnect = () => act(async () => { ([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Jira source")) as HTMLButtonElement).click(); });
  const submitForm = async () => {
    await act(async () => { host.querySelector("form")!.requestSubmit(); });
    await flush();
    await flush();
    await flush();
  };

  it("connects from a pasted issue link with derived name and V1 defaults, in create → credentials → refresh order, and clears the token", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api);
    await flush();
    await openConnect();
    // Credentials and the site are essential; issue scope and board filters
    // are visible independently before connecting.
    expect(host.querySelector("#task-source-new-url")).not.toBeNull();
    expect(host.querySelector("#task-source-new-email")).not.toBeNull();
    expect(host.querySelector('#task-source-new-token[type="password"]')).not.toBeNull();
    expect((host.querySelector("details.task-source-advanced") as HTMLDetailsElement).open).toBe(false);
    await setInput("task-source-new-url", "https://Acme.atlassian.net/browse/ABC-123?focusedCommentId=1");
    expect(host.querySelector("form")!.textContent).not.toContain("will be connected");
    await setInput("task-source-new-url", "https://Acme.atlassian.net/browse/ABC-123");
    expect(host.querySelector('[data-testid="site-hint"]')?.textContent).toContain("Issue ABC-123 lives on https://acme.atlassian.net");
    expect((host.querySelector("#task-source-new-scope") as HTMLSelectElement).value).toBe("assignedToMe");
    expect(host.querySelector("details.task-source-advanced summary")?.textContent).toContain("Acme Jira · every 15 minutes");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await submitForm();
    expect(api.calls.filter((call) => !call.startsWith("list") && !call.startsWith("candidates") && !call.startsWith("automation"))).toEqual([
      "create:Acme Jira:https://acme.atlassian.net:assignedToMe:-:null:review:5:900:9",
      "credentials:created:me@example.com:1",
      "refresh:created:1",
    ]);
    expect(host.textContent).toContain("Acme Jira connected: 2 candidates to review.");
    expect(host.querySelector('form[aria-label="Connect Jira"]')).toBeNull();
    expect(host.textContent).not.toContain("secret-token");
  });

  it("accepts a bare site URL and lets Advanced override name, scope and refresh", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api);
    await flush();
    await openConnect();
    await setInput("task-source-new-url", "https://my-team.atlassian.net/");
    await act(async () => { (host.querySelector("details.task-source-advanced") as HTMLDetailsElement).open = true; (host.querySelector("details.task-source-advanced") as HTMLDetailsElement).dispatchEvent(new Event("toggle")); });
    expect((host.querySelector("#task-source-new-name") as HTMLInputElement).placeholder).toBe("My Team Jira");
    await setInput("task-source-new-name", "Payments board");
    await setInput("task-source-new-scope", "jql");
    await setInput("task-source-new-jql", " project = PAY AND statusCategory != Done ");
    await setInput("task-source-new-refresh", "3600");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await submitForm();
    expect(api.calls.filter((call) => call.startsWith("create:"))).toEqual([
      "create:Payments board:https://my-team.atlassian.net:jql:-:project = PAY AND statusCategory != Done:review:5:3600:9",
    ]);
  });

  it("adds a board missing from discovery by pasted URL, combines it with another board, and applies assigned-to-me", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api);
    await flush();
    await openConnect();
    await setInput("task-source-new-url", "https://acme.atlassian.net/jira/software/c/projects/UKIE/boards/310");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Add board") as HTMLButtonElement).click();
    });
    await flush();

    expect(api.calls).toContain("boards:https://acme.atlassian.net:me@example.com:310");
    expect(api.calls.join("\n")).not.toContain("secret-token");
    expect(host.querySelector(".task-source-board-options")?.textContent).toContain("UK & IE Flow Next — UK & IE Flow Next (UKIE) (scrum)");
    expect((host.querySelector('.task-source-board-option input[value="310"]') as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Reload boards") as HTMLButtonElement).click();
    });
    await flush();
    await setBoardChecked("84", true);
    await submitForm();

    expect(api.calls.filter((call) => call.startsWith("create:"))).toEqual([
      "create:Acme Jira:https://acme.atlassian.net:assignedToMe:310=UK & IE Flow Next|84=Payments:null:review:5:900:9",
    ]);
    expect(api.calls.filter((call) => call.startsWith("credentials:") || call.startsWith("refresh:"))).toEqual([
      "credentials:created:me@example.com:1",
      "refresh:created:1",
    ]);
  });

  it("loads only the selected boards' statuses and submits multiple status filters", async () => {
    const api = actions({ sources: [], candidates: [] });
    let submittedStatuses: { id: string; name: string }[] = [];
    const create = api.create;
    api.create = async (params) => {
      submittedStatuses = params.statuses;
      return create(params);
    };
    await render(api);
    await flush();
    await openConnect();
    await setInput("task-source-new-url", "https://acme.atlassian.net");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Load boards") as HTMLButtonElement).click();
    });
    await flush();
    // Checking a board is enough: the status list belongs to the selected
    // boards, so it discovers itself instead of waiting for a load button.
    await setBoardChecked("84", true);
    await flush();
    await act(async () => {
      (host.querySelector('.task-source-status-option input[value="1"]') as HTMLInputElement).click();
      (host.querySelector('.task-source-status-option input[value="3"]') as HTMLInputElement).click();
    });
    // Both selections are scannable as chips, and the summary states how the
    // three filters compose before anything is saved.
    expect(host.querySelector('[aria-label="Selected statuses"]')?.textContent).toContain("Open");
    expect(host.querySelector('[data-testid="task-source-new-filter-summary"]')?.textContent)
      .toContain("Open or In Progress");
    await submitForm();

    expect(api.calls).toContain("statuses:https://acme.atlassian.net:me@example.com:84");
    expect(api.calls.join("\n")).not.toContain("secret-token");
    expect(submittedStatuses).toEqual([
      { id: "1", name: "Open" },
      { id: "3", name: "In Progress" },
    ]);
  });

  it("states how the three filters compose and keeps statuses locked until a board is chosen", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api);
    await flush();
    await openConnect();
    await setInput("task-source-new-url", "https://acme.atlassian.net");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");

    // Scope is a field of the form; the optional narrowing folds away and keeps
    // its own summary, so a closed disclosure still says what it holds.
    const summary = () => host.querySelector('[data-testid="task-source-new-filter-summary"]')?.textContent ?? "";
    const statusStep = () => host.querySelector(".task-source-narrow-body")!;
    expect(summary()).toBe("Any board · Any status");
    expect(host.querySelector(".task-source-narrow")?.hasAttribute("open")).toBe(false);
    expect(statusStep().querySelector(".task-source-step-locked")?.textContent).toMatch(/Pick a board first/);
    expect(api.calls.some((call) => call.startsWith("statuses:"))).toBe(false);

    await setInput("task-source-new-scope", "all");

    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Load boards") as HTMLButtonElement).click();
    });
    await flush();
    await setBoardChecked("84", true);
    await flush();
    expect(summary()).toContain("Payments");
    expect(statusStep().querySelector(".task-source-step-locked")).toBeNull();
    expect(statusStep().querySelector(".task-source-status-options")).not.toBeNull();

    // Removing the last board takes the status filter with it rather than
    // leaving an unsavable selection hidden behind the locked step.
    await act(async () => {
      (host.querySelector('.task-source-status-option input[value="1"]') as HTMLInputElement).click();
    });
    expect(summary()).toContain("Open");
    await act(async () => { (host.querySelector('button[aria-label="Remove Payments"]') as HTMLButtonElement).click(); });
    await flush();
    expect(summary()).toContain("Any board");
    expect(summary()).toContain("Any status");
    expect(statusStep().querySelector(".task-source-step-locked")).not.toBeNull();
    expect(statusStep().querySelector(".task-source-stale-notice")?.textContent)
      .toMatch(/status filter \(Open\) was cleared with the last board/);
  });

  it("re-reads statuses when the board set changes and names the selection it retired", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api);
    await flush();
    await openConnect();
    await setInput("task-source-new-url", "https://acme.atlassian.net");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Load boards") as HTMLButtonElement).click();
    });
    await flush();
    await setBoardChecked("84", true);
    await flush();
    await act(async () => {
      (host.querySelector('.task-source-status-option input[value="1"]') as HTMLInputElement).click();
      (host.querySelector('.task-source-status-option input[value="5"]') as HTMLInputElement).click();
    });
    const chips = () => host.querySelector('[aria-label="Selected statuses"]')?.textContent ?? "";
    expect(chips()).toContain("Done");

    await setBoardChecked("91", true);
    await flush();

    expect(api.calls.filter((call) => call.startsWith("statuses:"))).toEqual([
      "statuses:https://acme.atlassian.net:me@example.com:84",
      "statuses:https://acme.atlassian.net:me@example.com:84|91",
    ]);
    expect(api.calls.join("\n")).not.toContain("secret-token");
    expect(host.querySelector(".task-source-stale-notice")?.textContent).toMatch(/“Done” is not offered by the selected boards/);
    expect(chips()).toContain("Open");
    expect(chips()).not.toContain("Done");
    expect(host.querySelector('[data-testid="task-source-new-filter-summary"]')?.textContent).toContain("Open");
  });

  it("keeps a failed status discovery recoverable without blocking an untouched stored filter", async () => {
    const api = actions({
      sources: [source({ boards: [{ id: "84", name: "Payments" }], statuses: [{ id: "1", name: "Open" }] })],
      candidates: [],
    });
    const inner = api.listStoredStatuses;
    let failing = true;
    api.listStoredStatuses = async (params) => {
      if (!failing) return inner(params);
      api.calls.push(`storedStatuses:failed:${params.boardIds.join("|")}`);
      throw new Error("Jira unreachable");
    };
    await render(api);
    await flush();
    expect(host.querySelector(".task-source-detail-meta")?.textContent)
      .toContain("Assigned to me · Payments · Open");

    await act(async () => { ([...host.querySelectorAll("button")].find((button) => button.textContent === "Edit") as HTMLButtonElement).click(); });
    await flush();
    expect(api.calls).toContain("storedStatuses:failed:84");
    expect(host.querySelector(".task-source-step-error")?.textContent).toMatch(/Statuses could not be loaded: Jira unreachable/);
    // The stored filter was not touched, so it stays saveable.
    expect(host.querySelector('form[aria-label="Edit Team board"] button[type="submit"]')).not.toBeNull();
    expect((host.querySelector('form[aria-label="Edit Team board"] button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);

    failing = false;
    await act(async () => { ([...host.querySelectorAll("button")].find((button) => button.textContent === "Try again") as HTMLButtonElement).click(); });
    await flush();
    expect(host.querySelector(".task-source-step-error")).toBeNull();
    expect(host.querySelector(".task-source-status-options")?.textContent).toContain("In Progress");
  });

  it("does not reuse a board discovered for a different Jira site", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api);
    await flush();
    await openConnect();
    await setInput("task-source-new-url", "https://acme.atlassian.net");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Load boards") as HTMLButtonElement).click();
    });
    await flush();
    await setBoardChecked("84", true);
    await setInput("task-source-new-url", "https://other.atlassian.net");
    await submitForm();

    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Reload boards for this Jira site/);
    expect(api.calls.some((call) => call.startsWith("create:"))).toBe(false);
  });

  it("adds multiple board filters to an existing assigned source using stored credentials", async () => {
    const api = actions({ sources: [source()], candidates: [] });
    await render(api);
    await flush();
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Edit") as HTMLButtonElement).click();
    });
    await flush();

    // Opening the editor is the filter surface, so the boards visible to the
    // stored account arrive without a separate load step.
    expect(api.calls).toContain("storedBoards:source-1:https://acme.atlassian.net:3:all");
    expect(host.querySelector(".task-source-board-options")?.textContent).toContain("Payments — Money (scrum)");
    await setBoardChecked("84", true);
    await setBoardChecked("91", true);
    await submitForm();

    expect(api.calls).toContain("updateScope:assignedToMe:84=Payments|91=Operations:null");
    expect(api.calls).toContain("refresh:source-1:4");
    expect(api.calls.some((call) => call.startsWith("credentials:"))).toBe(false);
  });

  it("saves board 310 with multiple discovered statuses from an existing source", async () => {
    const api = actions({ sources: [source({ name: "Example Jira" })], candidates: [] });
    await render(api);
    await flush();
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Edit") as HTMLButtonElement).click();
    });
    await flush();

    const lookup = host.querySelector('input[aria-label="Board URL or ID"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(lookup, "310");
      lookup.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      ([...host.querySelectorAll("button")].find((button) => button.textContent === "Add board") as HTMLButtonElement).click();
    });
    await flush();
    await act(async () => {
      (host.querySelector('.task-source-status-option input[value="1"]') as HTMLInputElement).click();
      (host.querySelector('.task-source-status-option input[value="3"]') as HTMLInputElement).click();
    });

    const form = host.querySelector('form[aria-label="Edit Example Jira"]') as HTMLFormElement;
    await act(async () => form.requestSubmit());
    await flush();
    await flush();

    expect(host.textContent).not.toContain("Choose up to 10 different Jira boards");
    expect(api.calls).toContain("updateScope:assignedToMe:310=UK & IE Flow Next:null");
  });

  it("rejects unsafe addresses before any daemon call and keeps the JQL requirement", async () => {
    const api = actions({ sources: [], candidates: [] });
    await render(api);
    await flush();
    await openConnect();
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    for (const [address, expected] of [
      ["http://acme.atlassian.net", /https/],
      ["https://acme.atlassian.net.evil.example", /atlassian\.net/],
      ["https://acme.atlassian.net:8443", /port/],
      ["https://user@acme.atlassian.net", /user name/],
    ] as const) {
      await setInput("task-source-new-url", address);
      await submitForm();
      expect(host.querySelector('[role="alert"]')?.textContent, address).toMatch(expected);
    }
    await setInput("task-source-new-url", "https://acme.atlassian.net");
    await act(async () => { (host.querySelector("details.task-source-advanced") as HTMLDetailsElement).open = true; (host.querySelector("details.task-source-advanced") as HTMLDetailsElement).dispatchEvent(new Event("toggle")); });
    await setInput("task-source-new-scope", "jql");
    await submitForm();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/JQL/);
    expect(api.calls.filter((call) => !call.startsWith("list") && !call.startsWith("candidates") && !call.startsWith("automation"))).toEqual([]);
  });

  it("reports a credentials failure after create without losing the created source", async () => {
    const api = actions({ sources: [], candidates: [] });
    api.setCredentials = async () => { throw new Error("secure storage unavailable"); };
    await render(api);
    await flush();
    await openConnect();
    await setInput("task-source-new-url", "https://acme.atlassian.net/browse/ABC-9");
    await setInput("task-source-new-email", "me@example.com");
    await setInput("task-source-new-token", "secret-token");
    await submitForm();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/created but its credentials were not stored: secure storage unavailable/);
    expect(host.querySelector('[data-source-id="created"]')).not.toBeNull();
    // The created source is selected, so the remaining step is offered once.
    expect(host.querySelector(".task-source-detail-actions")?.textContent).toContain("Add credentials");
    expect(api.calls).not.toContain("refresh:created:1");
  });

  it("asks before deleting and sends the source's generation and the list revision", async () => {
    const api = actions({ sources: [source()], candidates: [] });
    await render(api);
    await flush();
    await act(async () => { (host.querySelector('button[aria-label="Delete Team board"]') as HTMLButtonElement).click(); });
    expect(api.calls).not.toContain("delete:source-1");
    expect(host.textContent).toContain("Tasks it added stay.");
    await act(async () => { ([...host.querySelectorAll("button")].find((button) => button.textContent === "Delete source") as HTMLButtonElement).click(); });
    await flush();
    await flush();
    expect(api.calls).toContain("delete:source-1");
    expect(host.textContent).toContain("No Task Sources yet");
    await act(async () => { ([...host.querySelectorAll("button")].find((button) => button.textContent === "Disable") as HTMLButtonElement | undefined)?.click(); });
  });

  it("toggles enabled through update with unchanged scope fields", async () => {
    const api = actions({ sources: [source()], candidates: [] });
    await render(api);
    await flush();
    await act(async () => { ([...host.querySelectorAll("button")].find((button) => button.textContent === "Disable") as HTMLButtonElement).click(); });
    await flush();
    expect(api.calls).toContain("update:source-1:false:3:10");
    expect(api.calls).toContain("updateIntake:review");
  });

  it("edits intake on an existing source and leaves worktree and agent to the Project", async () => {
    const api = actions({ sources: [source()], candidates: [] });
    await render(api, { agentCapabilities: [fullAgentCapability("codex")] });
    await flush();
    await act(async () => { ([...host.querySelectorAll("button")].find((button) => button.textContent === "Edit") as HTMLButtonElement).click(); });
    await flush();
    const form = host.querySelector('form[aria-label="Edit Team board"]') as HTMLFormElement;
    expect(form.querySelectorAll("h4")).toHaveLength(0);
    expect(form.querySelector("#task-source-edit-worktree")).toBeNull();
    expect(form.querySelector("#task-source-edit-agent")).toBeNull();
    // The Project section is not competing with the open source form.
    expect(host.querySelector('form[aria-label="New Task automation"]')).toBeNull();
    await setInput("task-source-edit-import-policy", "autoAdd");
    expect((form.querySelector("#task-source-edit-auto-import-limit") as HTMLInputElement).value).toBe("5");
    await setInput("task-source-edit-auto-import-limit", "8");
    await act(async () => { form.requestSubmit(); });
    await flush();
    await flush();
    expect(api.calls).toContain("updateIntake:autoAdd");
    expect(api.calls).toContain("updateAutoImportLimit:8");
  });

  it("names the selected source once and keeps its context on one line", async () => {
    const api = actions({ sources: [source({ name: "Team board" })], candidates: [candidate()] });
    await render(api);
    await flush();
    const pane = host.querySelector('section[aria-label="Team board"]') as HTMLElement;
    // One heading on the page carries the source name: the detail pane's.
    expect([...host.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["Team board"]);
    expect(pane.querySelector(".task-source-queue-bar > span")?.textContent).toContain("Review queue");
    // Everything the old cards repeated per row is stated once, here.
    expect(pane.querySelector(".task-source-detail-meta")?.textContent)
      .toBe("acme.atlassian.net · Assigned to me · Review · Every 15 minutes");
    // The rail stays a name, a health dot, an intake word, and a count.
    const rail = host.querySelector('[data-source-id="source-1"] .task-source-rail-select') as HTMLElement;
    expect(rail.querySelector(".task-source-rail-meta")?.textContent).toBe("Review");
    expect(rail.querySelector(".task-source-rail-count")?.textContent).toBe("2issues");
    expect(rail.textContent).not.toContain("atlassian.net");
    expect(rail.querySelectorAll("button")).toHaveLength(0);
  });
});
