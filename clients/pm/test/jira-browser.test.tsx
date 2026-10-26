// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmJiraIssue, PmJiraStatus } from "@termloop/pm-contract/pm";
import { JiraBrowserController, jiraFailureView } from "../src/renderer/composition/jira-browser.js";
import { newIssueUrl } from "../src/renderer/composition/JiraStage.js";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import {
  DEFAULT_JIRA_BROWSER,
  MAX_REMEMBERED_PROJECTS,
  MAX_SAVED_FILTERS,
  normalizeSavedFilters,
  readJiraBrowserPreference,
  readSavedFilters,
  saveFilter,
  writeJiraBrowserPreference,
  writeSavedFilters,
} from "../src/renderer/state/jira-browser-preference.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { RightActivityBar } from "../src/renderer/ui/RightActivityBar.js";
import { JiraBrowser, type JiraBrowserActions } from "../src/renderer/ui/jira/JiraBrowser.js";
import { JiraIssueList, type JiraIssueActions } from "../src/renderer/ui/jira/JiraIssueList.js";
import {
  boardLanes,
  groupIssuesByStatus,
  looksLikeJql,
  mergeStatusCatalog,
  searchParams,
  statusChips,
  statusRanks,
  type JiraBrowserView,
  type JiraQuery,
} from "../src/renderer/ui/jira/jira-view-state.js";
import { fakeBridge, ok } from "./fixtures.js";
import { render, typeInto } from "./render.js";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); });

function issue(key: string, status: string, category: PmJiraIssue["status"]["category"], overrides: Partial<PmJiraIssue> = {}): PmJiraIssue {
  return {
    id: key, key, url: `https://acme.atlassian.net/browse/${key}`, title: `Issue ${key}`, issueType: "Task",
    status: { name: status, category }, priority: "High", assignee: { displayName: "Ada Lovelace", avatarUrl: "https://avatars.example/a.png" },
    reporter: "Grace", labels: [], sprint: null, updatedAtEpochMs: 0, createdAtEpochMs: 0, pmTicketId: null, ...overrides,
  };
}

const statuses: PmJiraStatus[] = [
  { id: "1", name: "To Do", category: "new" },
  { id: "3", name: "In Progress", category: "indeterminate" },
  { id: "4", name: "Review", category: "indeterminate" },
  { id: "5", name: "Done", category: "done" },
];
const columns = [{ name: "Backlog", statusIds: ["1"] }, { name: "Doing", statusIds: ["4", "3"] }, { name: "Shipped", statusIds: ["5"] }];

function memoryStorage() {
  const store = new Map<string, string>();
  return { store, getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
}
const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };

describe("Jira view rules", () => {
  it("groups by status in board-column order, then category and name", () => {
    const issues = [issue("A-1", "Done", "done"), issue("A-2", "Review", "indeterminate"), issue("A-3", "Blocked", "indeterminate"), issue("A-4", "To Do", "new"), issue("A-5", "Review", "indeterminate")];
    const sections = groupIssuesByStatus(issues, statusRanks(statuses, columns));
    expect(sections.map((section) => [section.label, section.issues.length])).toEqual([["To Do", 1], ["Review", 2], ["Done", 1], ["Blocked", 1]]);
    const unranked = groupIssuesByStatus(issues, new Map());
    expect(unranked.map((section) => section.label)).toEqual(["To Do", "Blocked", "Review", "Done"]);
  });

  it("lays the board out by columns, keeps empty columns, and adds lanes for other statuses", () => {
    const issues = [issue("A-1", "In Progress", "indeterminate"), issue("A-2", "Blocked", "indeterminate")];
    expect(boardLanes(issues, statuses, columns).map((lane) => [lane.label, lane.issues.map((item) => item.key)])).toEqual([
      ["Backlog", []], ["Doing", ["A-1"]], ["Shipped", []], ["Blocked", ["A-2"]],
    ]);
    expect(boardLanes(issues, statuses, []).map((lane) => [lane.label, lane.issues.length])).toEqual([["To Do", 0], ["In Progress", 2], ["Done", 0]]);
  });

  it("offers chips from seen statuses plus selected ones it no longer sees", () => {
    const catalog = mergeStatusCatalog([], [issue("A-1", "Done", "done"), issue("A-2", "To Do", "new"), issue("A-3", "To Do", "new")]);
    expect(statusChips(catalog, ["Waiting"], new Map()).map((chip) => chip.name)).toEqual(["To Do", "Done", "Waiting"]);
  });

  it("maps filters to search params; custom JQL runs as written", () => {
    const query: JiraQuery = { preset: "assigned", jql: "ignored", jiraProjectKey: "PAY", statuses: ["To Do"], currentSprint: true, text: "  login  " };
    expect(searchParams("p1", query)).toEqual({ projectId: "p1", preset: "assigned", jiraProjectKey: "PAY", statuses: ["To Do"], currentSprint: true, text: "login" });
    expect(searchParams("p1", { ...query, jiraProjectKey: null, statuses: [], currentSprint: false, text: " " })).toEqual({ projectId: "p1", preset: "assigned" });
    expect(searchParams("p1", { ...query, preset: "custom", jql: " project = OPS " })).toEqual({ projectId: "p1", preset: "custom", jql: "project = OPS" });
    expect(looksLikeJql("project = ABC")).toBe(true);
    expect(looksLikeJql("status in (Done)")).toBe(true);
    expect(looksLikeJql("login is broken in safari")).toBe(false);
  });
});

describe("Jira browser memory", () => {
  it("keeps valid saved filters only: bounded, unique by id and name, at most 50", () => {
    const filters = normalizeSavedFilters([
      { id: "a", name: "Mine", jql: "assignee = currentUser()" },
      { id: "a", name: "Dup id", jql: "x = 1" },
      { id: "b", name: "MINE", jql: "x = 1" },
      { id: "c", name: "Huge", jql: "x".repeat(8 * 1024 + 1) },
      { id: "d", name: " ", jql: "x = 1" },
      "junk",
    ]);
    expect(filters).toEqual([{ id: "a", name: "Mine", jql: "assignee = currentUser()" }]);
    const many = Array.from({ length: 60 }, (_, index) => ({ id: `f${index}`, name: `F${index}`, jql: "x = 1" }));
    expect(normalizeSavedFilters(many)).toHaveLength(MAX_SAVED_FILTERS);
    expect(saveFilter(normalizeSavedFilters(many), { id: "new", name: "New", jql: "x = 1" })).toEqual({ error: "You can save up to 50 filters." });
    expect(saveFilter(filters, { id: "z", name: "mine", jql: "x = 1" })).toEqual({ error: "A saved filter with this name already exists." });
    expect(saveFilter(filters, { id: "a", name: "Renamed", jql: "x = 2" })).toEqual([{ id: "a", name: "Renamed", jql: "x = 2" }]);
  });

  it("remembers filters per project, ignores bad values, and survives blocked storage", () => {
    const storage = memoryStorage();
    writeJiraBrowserPreference("p1", { preset: "done", jiraProjectKey: "PAY", statuses: ["To Do"], currentSprint: true, mode: "board" }, storage);
    expect(readJiraBrowserPreference("p1", storage)).toEqual({ preset: "done", jiraProjectKey: "PAY", statuses: ["To Do"], currentSprint: true, mode: "board" });
    expect(readJiraBrowserPreference("p2", storage)).toEqual(DEFAULT_JIRA_BROWSER);
    storage.setItem("termloop.pm.jiraBrowser.v1", JSON.stringify({ p1: { preset: "custom", jiraProjectKey: "pay; drop", statuses: [1, "Done", "Done"], currentSprint: "yes", mode: "grid" } }));
    expect(readJiraBrowserPreference("p1", storage)).toEqual({ ...DEFAULT_JIRA_BROWSER, statuses: ["Done"] });
    for (let index = 0; index < MAX_REMEMBERED_PROJECTS + 5; index += 1) writeJiraBrowserPreference(`q${index}`, DEFAULT_JIRA_BROWSER, storage);
    expect(Object.keys(JSON.parse(storage.store.get("termloop.pm.jiraBrowser.v1")!))).toHaveLength(MAX_REMEMBERED_PROJECTS);
    expect(readJiraBrowserPreference("p1", blocked)).toEqual(DEFAULT_JIRA_BROWSER);
    expect(() => writeJiraBrowserPreference("p1", DEFAULT_JIRA_BROWSER, blocked)).not.toThrow();
    expect(readSavedFilters(blocked)).toEqual([]);
    expect(() => writeSavedFilters([], blocked)).not.toThrow();
  });
});

function searchResult(issues: PmJiraIssue[], jql = "assignee = currentUser()") {
  return ok({ projectId: "p1", issues, truncated: false, jql });
}

describe("JiraBrowserController", () => {
  it("reads the catalogues, searches with the remembered filters, and remembers changes", async () => {
    const storage = memoryStorage();
    writeJiraBrowserPreference("p1", { ...DEFAULT_JIRA_BROWSER, preset: "reported", jiraProjectKey: "PAY" }, storage);
    const bridge = fakeBridge((method) => {
      if (method === "pm_jira_search") return searchResult([issue("PAY-1", "To Do", "new")]);
      if (method === "pm_jira_projects_read") return ok({ projectId: "p1", projects: [{ key: "PAY", name: "Payments" }], truncated: false });
      if (method === "pm_jira_statuses_read") return ok({ projectId: "p1", statuses, columns });
      return ok({ projectId: "p1", filters: [{ id: "10", name: "Team", jql: "project = PAY" }], truncated: false });
    });
    const browser = new JiraBrowserController(bridge, "p1", async () => undefined, storage);
    await browser.start();
    expect(bridge.calls.map((call) => call.method).sort()).toEqual(["pm_jira_favourite_filters_read", "pm_jira_projects_read", "pm_jira_search", "pm_jira_statuses_read"]);
    expect(bridge.calls.find((call) => call.method === "pm_jira_search")?.params).toEqual({ projectId: "p1", preset: "reported", jiraProjectKey: "PAY" });
    expect(browser.state.statusCatalog.map((status) => status.name)).toEqual(["To Do"]);
    expect(browser.state.favourites).toHaveLength(1);

    await browser.toggleStatus("To Do");
    expect(bridge.calls.at(-1)?.params).toMatchObject({ statuses: ["To Do"] });
    await browser.setProjectKey(null);
    expect(browser.state.query.statuses).toEqual([]);
    browser.setMode("board");
    await browser.runJql("project = OPS");
    expect(bridge.calls.filter((call) => call.method === "pm_jira_search").at(-1)?.params).toEqual({ projectId: "p1", preset: "custom", jql: "project = OPS" });
    expect(readJiraBrowserPreference("p1", storage)).toMatchObject({ preset: "reported", jiraProjectKey: null, mode: "board" });
  });

  it("shows only the latest search's answer", async () => {
    let release: ((value: ReturnType<typeof ok>) => void) | undefined;
    const bridge = fakeBridge(() => searchResult([]));
    bridge.call = (async (method: string) => {
      if (method !== "pm_jira_search") return ok({});
      if (!release) return new Promise<ReturnType<typeof ok>>((resolve) => { release = resolve; });
      return searchResult([issue("NEW-1", "To Do", "new")]);
    }) as typeof bridge.call;
    const browser = new JiraBrowserController(bridge, "p1", async () => undefined, memoryStorage());
    const first = browser.search();
    await browser.setPreset("done");
    release!(searchResult([issue("OLD-1", "To Do", "new")]));
    await first;
    expect(browser.state.result?.issues.map((item) => item.key)).toEqual(["NEW-1"]);
  });

  it("explains Jira failures and marks a missing source as not connected", async () => {
    const bridge = fakeBridge(() => ({ ok: false, error: { code: "operationFailed", message: "the Jira request failed", details: { kind: "jiraFailed", reason: "notConfigured" } } }));
    const browser = new JiraBrowserController(bridge, "p1", async () => undefined, memoryStorage());
    await browser.search();
    expect(browser.state.failure).toEqual({ message: "Jira is not connected for this project.", notConnected: true });
    expect(jiraFailureView({ code: "operationFailed", message: "x", details: { kind: "jiraFailed", reason: "rateLimited" } }).notConnected).toBe(false);
  });

  it("adds an issue to PM once and links the row to the new ticket", async () => {
    const bridge = fakeBridge(() => searchResult([issue("PAY-7", "To Do", "new")]));
    const add = vi.fn(async () => "ticket-9");
    const browser = new JiraBrowserController(bridge, "p1", add, memoryStorage());
    await browser.search();
    const target = browser.state.result!.issues[0]!;
    await Promise.all([browser.addToPm(target), browser.addToPm(target)]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(browser.state.result!.issues[0]!.pmTicketId).toBe("ticket-9");
    expect(browser.state.adding).toEqual([]);
  });

  it("creates the PM ticket in the given sprint with the issue's Jira link", async () => {
    const bridge = fakeBridge((method) => method === "pm_ticket_create" ? ok({ id: "t1" }) : { ok: false, error: { code: "unavailable", message: "offline" } });
    const controller = new PmController(bridge, createPmStore({ projectId: "p1" }));
    await controller.createTicket("Checkout fails", "sprint-1", { jiraUrl: "https://acme.atlassian.net/browse/PAY-7" }, false);
    expect(bridge.calls[0]).toEqual({ method: "pm_ticket_create", params: { projectId: "p1", title: "Checkout fails", sprintId: "sprint-1", jiraUrl: "https://acme.atlassian.net/browse/PAY-7" } });
    expect(newIssueUrl("https://acme.atlassian.net/")).toBe("https://acme.atlassian.net/secure/CreateIssue!default.jspa");
  });
});

function issueActions(overrides: Partial<JiraIssueActions> = {}): JiraIssueActions {
  return { adding: [], onCopyKey: vi.fn(), onOpenTicket: vi.fn(), onAddToPm: vi.fn(), onOpenInJira: vi.fn(), ...overrides };
}

describe("Jira issue list", () => {
  it("renders collapsible status groups and opens a linked ticket or adds an unlinked issue", () => {
    const actions = issueActions();
    const linked = issue("PAY-1", "To Do", "new", { pmTicketId: "ticket-1", labels: ["a", "b", "c", "d"] });
    const unlinked = issue("PAY-2", "Done", "done", { assignee: null, priority: null });
    const view = render(<JiraIssueList sections={groupIssuesByStatus([linked, unlinked], new Map())} now={60_000 * 5} actions={actions} />);
    cleanup = view.unmount;
    const heads = [...view.container.querySelectorAll<HTMLButtonElement>(".jira-section-head")];
    expect(heads.map((head) => head.textContent)).toEqual(["To Do1", "Done1"]);
    const row = (key: string) => view.container.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    expect(row("PAY-1").querySelector(".jira-avatar")?.textContent).toBe("AL");
    expect(row("PAY-1").querySelector("img")).toBeNull();
    expect(row("PAY-1").textContent).toContain("+1");
    expect(row("PAY-2").textContent).toContain("Unassigned");
    const button = (key: string, text: string) => [...row(key).querySelectorAll("button")].find((candidate) => candidate.textContent === text)!;
    act(() => button("PAY-1", "Open in PM").click());
    expect(actions.onOpenTicket).toHaveBeenCalledWith("ticket-1");
    act(() => button("PAY-2", "Add to PM").click());
    expect(actions.onAddToPm).toHaveBeenCalledWith(unlinked);
    act(() => row("PAY-2").querySelector<HTMLButtonElement>('[aria-label="Open PAY-2 in Jira"]')!.click());
    expect(actions.onOpenInJira).toHaveBeenCalledWith(unlinked.url);
    act(() => heads[0]!.click());
    expect(view.container.querySelector('[data-key="PAY-1"]')).toBeNull();
  });
});

function browserView(overrides: Partial<JiraBrowserView> = {}): JiraBrowserView {
  return {
    query: { preset: "assigned", jql: "", jiraProjectKey: null, statuses: [], currentSprint: false, text: "" },
    mode: "list", result: undefined, loading: false, failure: undefined, projects: [], statuses: [], columns: [], favourites: [],
    statusCatalog: [], savedFilters: [], activeFilterId: undefined, adding: [], ...overrides,
  };
}

function browserActions(): JiraBrowserActions {
  const fn = () => vi.fn();
  return {
    onNewIssue: undefined, onPreset: fn(), onProjectKey: fn(), onToggleStatus: fn(), onClearStatuses: fn(), onRunJql: fn(), onText: fn(),
    onApplyFilter: fn(), onSaveFilter: vi.fn(() => undefined), onDeleteFilter: fn(), onRefresh: fn(), onMode: fn(), onCurrentSprint: fn(),
    onOpenSettings: fn(), onCopyKey: fn(), onOpenTicket: fn(), onAddToPm: fn(), onOpenInJira: fn(),
  };
}

describe("JiraBrowser states", () => {
  it("offers Settings when Jira is not connected", () => {
    const actions = browserActions();
    const view = render(<JiraBrowser connection="notConnected" view={browserView()} now={0} actions={actions} />);
    cleanup = view.unmount;
    expect(view.container.textContent).toContain("Jira is not connected for this project.");
    act(() => [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Open Settings")!.click());
    expect(actions.onOpenSettings).toHaveBeenCalled();
  });

  it("shows the failure with Retry, the count with truncation, and the empty state", () => {
    const actions = browserActions();
    const view = render(<JiraBrowser connection="connected" view={browserView({ failure: { message: "Jira is unavailable right now.", notConnected: false } })} now={0} actions={actions} />);
    cleanup = view.unmount;
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Jira is unavailable right now.");
    act(() => [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click());
    expect(actions.onRefresh).toHaveBeenCalled();
    view.unmount();

    const truncated = render(<JiraBrowser connection="connected" view={browserView({ result: { projectId: "p1", issues: [issue("A-1", "To Do", "new")], truncated: true, jql: "statusCategory != Done" } })} now={0} actions={actions} />);
    cleanup = truncated.unmount;
    expect(truncated.container.querySelector(".jira-head .meta")?.textContent).toBe("1 shown · truncated");
    expect(truncated.container.querySelector<HTMLInputElement>('[aria-label="Effective JQL"]')?.value).toBe("statusCategory != Done");
    truncated.unmount();

    const empty = render(<JiraBrowser connection="connected" view={browserView({ loading: true })} now={0} actions={actions} />);
    cleanup = empty.unmount;
    expect(empty.container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("debounces text search and runs JQL-looking input on Enter", () => {
    vi.useFakeTimers();
    const actions = browserActions();
    const view = render(<JiraBrowser connection="connected" view={browserView()} now={0} actions={actions} />);
    cleanup = view.unmount;
    const input = view.container.querySelector<HTMLInputElement>('[aria-label="Search Jira issues"]')!;
    typeInto(input, "checkout");
    act(() => { vi.advanceTimersByTime(299); });
    expect(actions.onText).not.toHaveBeenCalledWith("checkout");
    act(() => { vi.advanceTimersByTime(1); });
    expect(actions.onText).toHaveBeenCalledWith("checkout");
    typeInto(input, "project = ABC");
    act(() => { vi.advanceTimersByTime(500); });
    expect(actions.onText).not.toHaveBeenCalledWith("project = ABC");
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(actions.onRunJql).toHaveBeenCalledWith("project = ABC");
  });
});

describe("Jira stage navigation", () => {
  it("shows the Jira item disabled without a source and toggles the stage with one", () => {
    const onToggle = vi.fn();
    const disabled = render(<RightActivityBar open view="sprints" onSelect={vi.fn()} jira={{ available: false, active: false, onToggle }} />);
    cleanup = disabled.unmount;
    const item = disabled.container.querySelector<HTMLButtonElement>('[aria-label="Jira issues"]')!;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("Connect Jira in Settings");
    disabled.unmount();

    const enabled = render(<RightActivityBar open view="sprints" onSelect={vi.fn()} jira={{ available: true, active: true, onToggle }} />);
    cleanup = enabled.unmount;
    const active = enabled.container.querySelector<HTMLButtonElement>('[aria-label="Jira issues"]')!;
    expect(active.getAttribute("aria-pressed")).toBe("true");
    act(() => active.click());
    expect(onToggle).toHaveBeenCalled();
  });

  it("returns the stage to what Jira replaced", () => {
    const store = createPmStore({ view: "ticket" });
    const controller = new PmController(fakeBridge(() => ok({})), store);
    controller.toggleStage("jira");
    expect(store.getState().view).toBe("jira");
    controller.toggleStage("jira");
    expect(store.getState().view).toBe("ticket");
    controller.setView("overview");
    controller.toggleStage("jira");
    controller.setView("jira");
    controller.toggleStage("jira");
    expect(store.getState().view).toBe("overview");
  });

  it("returns from Settings to the view Jira replaced, not to Jira", () => {
    const store = createPmStore({ view: "ticket" });
    const controller = new PmController(fakeBridge(() => ok({})), store);
    controller.toggleStage("jira");
    controller.toggleStage("settings");
    expect(store.getState().view).toBe("settings");
    controller.toggleStage("settings");
    expect(store.getState().view).toBe("ticket");
  });
});
