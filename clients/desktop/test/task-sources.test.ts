import { describe, expect, it } from "vitest";
import type { TaskSourceCandidateDto, TaskSourceDto } from "@termloop/contract/current";
import {
  applyBoardChange,
  candidateActions,
  deriveSourceName,
  emptyTaskSourceDraft,
  filterCandidates,
  filterSummaryLine,
  filterSummaryParts,
  intakeLabel,
  isStaleExpectationMessage,
  mergeBoardOptions,
  normalizeJiraBoardLookup,
  normalizeJiraSiteInput,
  normalizeSiteBaseUrl,
  orderCandidates,
  reconcileStatusSelection,
  relativeTime,
  runTaskSourceSetup,
  sameSelection,
  scopeLabel,
  setupFailureCopy,
  sourceHealth,
  staleStatusNotice,
  taskSourceCredentialsError,
  taskSourceDraftError,
} from "../src/renderer/task-sources.js";
import {
  agentChoiceOptions,
  projectTaskAutomationChanged,
  projectTaskAutomationDraftFrom,
  projectTaskAutomationError,
  taskAutomationSummary,
  taskCreationIntent,
} from "../src/renderer/project-task-automation.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

export function source(overrides: Partial<TaskSourceDto> = {}): TaskSourceDto {
  return {
    id: "source-1", projectId: "project-1", provider: "jira", name: "Team board", enabled: true, generation: 3,
    siteBaseUrl: "https://acme.atlassian.net", scopeKind: "assignedToMe", boards: [], statuses: [], jql: null, importPolicy: "review", autoImportActiveTaskLimit: 5,
    refreshIntervalSeconds: 900, credentialState: "present", runtimeState: "idle", failureReason: null,
    lastAttemptAtEpochMs: 1_000_000, lastSuccessfulAtEpochMs: 1_000_000, retryAfterEpochMs: null,
    candidateCount: 2, truncated: false, createdAtEpochMs: 1, updatedAtEpochMs: 1,
    ...overrides,
  };
}

export function candidate(overrides: Partial<TaskSourceCandidateDto> = {}): TaskSourceCandidateDto {
  return {
    sourceId: "source-1", externalId: "10001", key: "ACME-1", url: "https://acme.atlassian.net/browse/ACME-1",
    summary: "Fix login", description: null, statusName: "To Do", assigneeDisplay: "Ferit", updatedAt: "2026-08-20T10:00:00.000Z",
    state: "new", taskId: null, observedGeneration: 3, observationSequence: 7,
    ...overrides,
  };
}

describe("Task Source draft validation", () => {
  it("mirrors the daemon's Atlassian Cloud site gate and trims paste artifacts", () => {
    const draft = { ...emptyTaskSourceDraft(), name: "Board", siteBaseUrl: "https://acme.atlassian.net/ " };
    expect(normalizeSiteBaseUrl(draft.siteBaseUrl)).toBe("https://acme.atlassian.net");
    expect(taskSourceDraftError(draft)).toBeUndefined();
    expect(taskSourceDraftError({ ...draft, siteBaseUrl: "http://acme.atlassian.net" })).toMatch(/atlassian\.net/);
    expect(taskSourceDraftError({ ...draft, siteBaseUrl: "https://acme.atlassian.net/browse/X" })).toMatch(/no path/);
    expect(taskSourceDraftError({ ...draft, siteBaseUrl: "https://jira.example.com" })).toMatch(/atlassian\.net/);
  });

  it("requires JQL only for the advanced scope and bounds the interval", () => {
    const draft = { ...emptyTaskSourceDraft(), name: "Board", siteBaseUrl: "https://acme.atlassian.net" };
    expect(taskSourceDraftError({ ...draft, scopeKind: "jql", jql: "  " })).toMatch(/JQL/);
    expect(taskSourceDraftError({ ...draft, scopeKind: "jql", jql: "project = ACME" })).toBeUndefined();
    expect(taskSourceDraftError({ ...draft, refreshIntervalSeconds: 30 })).toMatch(/interval/);
    expect(taskSourceDraftError({ ...draft, refreshIntervalSeconds: 86_401 })).toMatch(/interval/);
  });

  it("accepts provider-discovered board rows and rejects duplicate or excessive selections", () => {
    const draft = { ...emptyTaskSourceDraft(), name: "Board", siteBaseUrl: "https://acme.atlassian.net" };
    expect(taskSourceDraftError({ ...draft, boards: [{ id: "84", name: "Payments" }, { id: "91", name: "Operations" }] })).toBeUndefined();
    expect(taskSourceDraftError({ ...draft, boards: [{ id: "84", name: "Payments" }, { id: "84", name: "Duplicate" }] })).toMatch(/up to 10 different Jira boards/);
    expect(taskSourceDraftError({ ...draft, boards: Array.from({ length: 11 }, (_, index) => ({ id: String(index + 1), name: `Board ${index + 1}` })) })).toMatch(/up to 10 different Jira boards/);
  });

  it("accepts multiple statuses only when at least one board is selected", () => {
    const draft = { ...emptyTaskSourceDraft(), name: "Board", siteBaseUrl: "https://acme.atlassian.net" };
    const statuses = [{ id: "1", name: "Open" }, { id: "3", name: "In Progress" }];
    expect(taskSourceDraftError({ ...draft, statuses })).toMatch(/at least one Jira board/);
    expect(taskSourceDraftError({ ...draft, boards: [{ id: "84", name: "Payments" }], statuses })).toBeUndefined();
    expect(taskSourceDraftError({ ...draft, boards: [{ id: "84", name: "Payments" }], statuses: [...statuses, statuses[0]!] })).toMatch(/up to 100 different Jira statuses/);
  });

  it("keeps intake on the source and worktree/agent off it", () => {
    const draft = { ...emptyTaskSourceDraft(), name: "Board", siteBaseUrl: "https://acme.atlassian.net" };
    expect(draft).toMatchObject({ importPolicy: "review", autoImportActiveTaskLimit: 5 });
    expect(draft).not.toHaveProperty("createWorktree");
    expect(draft).not.toHaveProperty("agentId");
    expect(taskSourceDraftError({ ...draft, importPolicy: "autoAdd" })).toBeUndefined();
    expect(taskSourceDraftError({ ...draft, importPolicy: "autoAdd", autoImportActiveTaskLimit: 0 })).toMatch(/between 1 and 50/);
    expect(taskSourceDraftError({ ...draft, importPolicy: "autoAdd", autoImportActiveTaskLimit: 51 })).toMatch(/between 1 and 50/);
    expect(intakeLabel("review")).toBe("Review");
    expect(intakeLabel("autoAdd", 7)).toBe("Auto-import · 7 active max");
  });

  it("checks credentials shape without ever echoing the token", () => {
    expect(taskSourceCredentialsError("me@example.com", "tok en")).toMatch(/spaces/);
    expect(taskSourceCredentialsError("me", "token")).toMatch(/email/);
    expect(taskSourceCredentialsError("me@@example.com", "token")).toMatch(/email/);
    expect(taskSourceCredentialsError("me@example.com", "")).toMatch(/token/);
    expect(taskSourceCredentialsError("me@example.com", "abc")).toBeUndefined();
  });

  it("uses the contract's UTF-8 byte limits", () => {
    const draft = { ...emptyTaskSourceDraft(), name: "ş".repeat(41), siteBaseUrl: "https://acme.atlassian.net" };
    expect(taskSourceDraftError(draft)).toMatch(/UTF-8 bytes/);
    expect(taskSourceCredentialsError(`${"ş".repeat(126)}@x`, "token")).toBeUndefined();
    expect(taskSourceCredentialsError(`${"ş".repeat(127)}@x`, "token")).toMatch(/too long/);
    expect(taskSourceCredentialsError("me@example.com", "ş".repeat(513))).toMatch(/too long/);
  });
});

describe("Task Source filter projection", () => {
  const filters = (overrides: Partial<TaskSourceDto> = {}) => source(overrides);

  it("always names all three filters, so the form can show that they compose", () => {
    expect(filterSummaryParts(filters())).toEqual([
      { key: "scope", label: "Issue scope", value: "Assigned to me", filled: true },
      { key: "boards", label: "Boards", value: "Any board", filled: false },
      { key: "statuses", label: "Statuses", value: "Any status", filled: false },
    ]);
    expect(filterSummaryParts(filters({ scopeKind: "jql" }))[0]).toMatchObject({ value: "Advanced JQL" });
    expect(filterSummaryParts(filters({ scopeKind: "all" }))[0]).toMatchObject({ value: "All issues" });
  });

  it("reads one or two selections by name and counts beyond that, keeping the full list as detail", () => {
    const board = (id: string, name: string) => ({ id, name });
    expect(filterSummaryParts(filters({ boards: [board("84", "Payments")] }))[1]).toEqual({
      key: "boards", label: "Boards", value: "Payments", filled: true,
    });
    expect(filterSummaryParts(filters({ boards: [board("84", "Payments"), board("91", "Ops")] }))[1])
      .toMatchObject({ value: "Payments or Ops" });
    expect(filterSummaryParts(filters({ boards: [board("84", "Payments"), board("91", "Ops"), board("310", "UKIE")] }))[1])
      .toEqual({ key: "boards", label: "Boards", value: "3 boards", detail: "Payments, Ops, UKIE", filled: true });
    expect(filterSummaryParts(filters({ statuses: [board("1", "Open"), board("3", "In Progress")] }))[2])
      .toMatchObject({ value: "Open or In Progress" });
  });

  it("drops the unset filters from the one-line row form", () => {
    expect(filterSummaryLine(filters())).toBe("Assigned to me");
    expect(scopeLabel(filters({ boards: [{ id: "84", name: "Payments" }] }))).toBe("Assigned to me · Payments");
    expect(scopeLabel(filters({
      scopeKind: "all",
      boards: [{ id: "84", name: "Payments" }],
      statuses: [{ id: "1", name: "Open" }, { id: "3", name: "In Progress" }],
    }))).toBe("All issues · Payments · Open or In Progress");
  });

  it("keeps the statuses the new boards still offer and names only the retired ones", () => {
    const selected = [{ id: "1", name: "Open" }, { id: "5", name: "Done" }];
    const discovered = [{ id: "1", name: "Open" }, { id: "3", name: "In Progress" }];
    expect(reconcileStatusSelection(selected, discovered)).toEqual({ statuses: [{ id: "1", name: "Open" }], dropped: ["Done"] });
    expect(reconcileStatusSelection(selected, selected)).toEqual({ statuses: selected, dropped: [] });
    // A renamed status is a different status: the stale name cannot be sent on.
    expect(reconcileStatusSelection([{ id: "1", name: "Open" }], [{ id: "1", name: "Opened" }]))
      .toEqual({ statuses: [], dropped: ["Open"] });
    expect(reconcileStatusSelection([], discovered)).toEqual({ statuses: [], dropped: [] });
  });

  it("says what a board change cost, or nothing at all", () => {
    expect(staleStatusNotice([])).toBeUndefined();
    expect(staleStatusNotice(["Done"])).toBe("“Done” is not offered by the selected boards, so it left the status filter.");
    expect(staleStatusNotice(["Done", "Blocked", "Review"]))
      .toBe("“Done”, “Blocked” and “Review” are not offered by the selected boards, so they left the status filter.");
  });

  it("takes the status filter down with the last board and says so", () => {
    const boards = [{ id: "84", name: "Payments" }];
    const statuses = [{ id: "1", name: "Open" }, { id: "3", name: "In Progress" }];
    expect(applyBoardChange(boards, statuses)).toEqual({ boards, statuses, notice: undefined });
    expect(applyBoardChange([], [])).toEqual({ boards: [], statuses: [], notice: undefined });
    const cleared = applyBoardChange([], statuses);
    expect(cleared.statuses).toEqual([]);
    expect(cleared.notice).toMatch(/status filter \(Open, In Progress\) was cleared with the last board/);
  });

  it("compares stored selections exactly, so an untouched filter needs no rediscovery", () => {
    const stored = [{ id: "84", name: "Payments" }, { id: "91", name: "Ops" }];
    expect(sameSelection(stored, [...stored])).toBe(true);
    expect(sameSelection(stored, [stored[1]!, stored[0]!])).toBe(false);
    expect(sameSelection(stored, [stored[0]!])).toBe(false);
    expect(sameSelection(stored, [{ id: "84", name: "Payments renamed" }, stored[1]!])).toBe(false);
    expect(sameSelection([], [])).toBe(true);
  });
});

describe("Task Source health", () => {
  const now = 1_000_000 + 5 * 60_000;
  it("names the actionable state before anything else", () => {
    expect(sourceHealth(source({ enabled: false }), now).label).toBe("Disabled");
    expect(sourceHealth(source({ runtimeState: "refreshing" }), now).tone).toBe("busy");
    expect(sourceHealth(source({ credentialState: "none" }), now)).toMatchObject({ tone: "attention", label: "Needs credentials" });
    expect(sourceHealth(source({ runtimeState: "attention", failureReason: "rateLimited", retryAfterEpochMs: now + 120_000 }), now).detail).toMatch(/Retry in 2 min/);
    expect(sourceHealth(source(), now)).toEqual({ tone: "ok", label: "Synced 5 min ago" });
    expect(sourceHealth(source({ lastSuccessfulAtEpochMs: null }), now).label).toBe("Not refreshed yet");
  });

  it("formats relative time in both directions", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now + 10_000, now)).toBe("in under a minute");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now + 2 * 86_400_000, now)).toBe("in 2 d");
  });
});

describe("Candidates", () => {
  it("orders every Jira candidate newest first and filters actionable rows separately", () => {
    const rows = [
      candidate({ externalId: "1", key: "A-1", state: "added", taskId: "task-1", updatedAt: "2026-08-26T00:00:00.000Z" }),
      candidate({ externalId: "2", key: "A-2", state: "new", updatedAt: "2026-08-01T00:00:00.000Z" }),
      candidate({ externalId: "3", key: "A-3", state: "ignored", updatedAt: "2026-08-22T00:00:00.000Z" }),
      candidate({ externalId: "4", key: "A-4", state: "changed", taskId: "task-4", updatedAt: "2026-08-25T00:00:00.000Z" }),
      candidate({ externalId: "5", key: "A-5", state: "noLongerMatches", updatedAt: "2026-08-21T00:00:00.000Z" }),
      candidate({ externalId: "6", key: "A-6", state: "new", updatedAt: "2026-08-24T00:00:00.000Z" }),
      candidate({ externalId: "7", key: "A-7", state: "possibleDuplicate", taskId: "task-7", updatedAt: "2026-08-23T00:00:00.000Z" }),
    ];
    expect(orderCandidates(rows).map((row) => row.key)).toEqual(["A-1", "A-4", "A-6", "A-7", "A-3", "A-5", "A-2"]);
    expect(filterCandidates(rows, "actionable").map((row) => row.key).sort()).toEqual(["A-2", "A-4", "A-6", "A-7"]);
  });

  it("offers writes only where the review policy allows them", () => {
    expect(candidateActions(candidate({ state: "new" }))).toEqual({ import: true, ignore: true, unignore: false, openTask: false });
    expect(candidateActions(candidate({ state: "changed", taskId: "task-4" }))).toEqual({ import: false, ignore: false, unignore: false, openTask: true });
    expect(candidateActions(candidate({ state: "possibleDuplicate", taskId: "task-7" }))).toEqual({ import: false, ignore: false, unignore: false, openTask: true });
    expect(candidateActions(candidate({ state: "added", taskId: "task-1" }))).toEqual({ import: false, ignore: false, unignore: false, openTask: true });
    expect(candidateActions(candidate({ state: "ignored" }))).toEqual({ import: false, ignore: false, unignore: true, openTask: false });
    expect(candidateActions(candidate({ state: "noLongerMatches" }))).toEqual({ import: false, ignore: false, unignore: false, openTask: false });
  });
});

describe("Task Source setup sequence", () => {
  const created = source({ id: "created", generation: 1, credentialState: "none", lastSuccessfulAtEpochMs: null });
  const describe_ = (error: unknown) => (error instanceof Error ? error.message : String(error));

  it("runs create, credentials, refresh in order and reports the first candidates", async () => {
    const calls: string[] = [];
    const outcome = await runTaskSourceSetup({
      create: async () => { calls.push("create"); return { source: created, stateRevision: 4 }; },
      setCredentials: async (target) => { calls.push(`credentials:${target.id}`); return { sourceId: target.id, credentialState: "present" }; },
      refresh: async (target) => { calls.push(`refresh:${target.id}`); return { sourceId: target.id, refreshed: true, failureReason: null, candidateCount: 3, truncated: false, observationSequence: 1 }; },
    }, describe_);
    expect(calls).toEqual(["create", "credentials:created", "refresh:created"]);
    expect(outcome).toMatchObject({ ok: true, credentialState: "present", refresh: { candidateCount: 3 } });
  });

  it("keeps the created source visible when a later step fails and names the remaining step", async () => {
    const outcome = await runTaskSourceSetup({
      create: async () => ({ source: created, stateRevision: 4 }),
      setCredentials: async () => { throw new Error("secure storage locked"); },
      refresh: async () => { throw new Error("unreachable"); },
    }, describe_);
    expect(outcome).toMatchObject({ ok: false, stage: "credentials", source: { id: "created" } });
    expect(setupFailureCopy(outcome as Extract<typeof outcome, { ok: false }>)).toMatch(/created but its credentials were not stored: secure storage locked/);

    const refreshFailed = await runTaskSourceSetup({
      create: async () => ({ source: created, stateRevision: 4 }),
      setCredentials: async () => ({ sourceId: "created", credentialState: "present" }),
      refresh: async () => { throw new Error("rate limited"); },
    }, describe_);
    expect(refreshFailed).toMatchObject({ ok: false, stage: "refresh" });
    expect(setupFailureCopy(refreshFailed as Extract<typeof refreshFailed, { ok: false }>)).toMatch(/first refresh failed: rate limited/);

    const typedRefreshFailure = await runTaskSourceSetup({
      create: async () => ({ source: created, stateRevision: 4 }),
      setCredentials: async () => ({ sourceId: "created", credentialState: "present" }),
      refresh: async () => ({ sourceId: "created", refreshed: false, failureReason: "scopeInvalid", candidateCount: 0, truncated: false, observationSequence: 2 }),
    }, describe_);
    expect(typedRefreshFailure).toMatchObject({ ok: false, stage: "refresh", message: expect.stringMatching(/rejected the scope/) });
  });

  it("stops at create when the daemon rejects it", async () => {
    const outcome = await runTaskSourceSetup({
      create: async () => { throw new Error("conflict: expectedRevision"); },
      setCredentials: async () => { throw new Error("must not run"); },
      refresh: async () => { throw new Error("must not run"); },
    }, describe_);
    expect(outcome).toEqual({ ok: false, stage: "create", message: "conflict: expectedRevision" });
    expect(isStaleExpectationMessage("conflict: expectedRevision")).toBe(true);
    expect(isStaleExpectationMessage("Jira unreachable")).toBe(false);
  });
});

describe("Jira address normalization", () => {
  it("accepts the site itself, an issue link, or another same-site page and folds to the exact lowercase origin", () => {
    expect(normalizeJiraSiteInput("https://acme.atlassian.net")).toEqual({ ok: true, siteBaseUrl: "https://acme.atlassian.net", tenant: "acme", kind: "site" });
    expect(normalizeJiraSiteInput("  https://Acme.Atlassian.net/  ")).toMatchObject({ ok: true, siteBaseUrl: "https://acme.atlassian.net", kind: "site" });
    expect(normalizeJiraSiteInput("https://acme.atlassian.net/browse/ABC-123")).toEqual({ ok: true, siteBaseUrl: "https://acme.atlassian.net", tenant: "acme", kind: "issue", issueKey: "ABC-123" });
    expect(normalizeJiraSiteInput("https://acme.atlassian.net/jira/software/c/projects/ABC/boards/4")).toMatchObject({ ok: true, siteBaseUrl: "https://acme.atlassian.net", kind: "path", boardId: "4" });
    expect(normalizeJiraSiteInput("acme.atlassian.net/browse/ABC-1")).toMatchObject({ ok: true, siteBaseUrl: "https://acme.atlassian.net", kind: "issue" });
    expect(normalizeJiraSiteInput("https://my-team.atlassian.net")).toMatchObject({ ok: true, tenant: "my-team" });
    // A backslash is a path separator for https in every browser and in
    // WHATWG URL, so the host here really is acme.atlassian.net. The origin is
    // rebuilt from the parsed tenant rather than the pasted text, so the result
    // is the safe site either way.
    expect(normalizeJiraSiteInput("https://acme.atlassian.net\\evil/browse/ABC-1"))
      .toMatchObject({ ok: true, siteBaseUrl: "https://acme.atlassian.net", kind: "path" });
  });

  it("refuses anything that could point somewhere else", () => {
    const cases: [string, RegExp][] = [
      ["", /Paste your Jira site/],
      ["http://acme.atlassian.net", /https/],
      ["ftp://acme.atlassian.net", /https/],
      ["https://user:pw@acme.atlassian.net", /user name or password/],
      ["https://acme.atlassian.net:8443", /port/],
      ["https://acme.atlassian.net/browse/ABC-1?token=x", /query/],
      ["https://acme.atlassian.net/browse/ABC-1#comment", /fragment/],
      ["https://acme.atlassian.net.evil.example/browse/ABC-1", /atlassian\.net/],
      ["https://evil.acme.atlassian.net", /atlassian\.net/],
      ["https://atlassian.net", /atlassian\.net/],
      ["https://acme_x.atlassian.net", /atlassian\.net/],
      ["https://-acme.atlassian.net", /atlassian\.net/],
      ["https://jira.example.com/browse/ABC-1", /atlassian\.net/],
      ["https://acme.atlassian.net/browse/ABC 1", /spaces/],
    ];
    for (const [input, expected] of cases) {
      const result = normalizeJiraSiteInput(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.message, input).toMatch(expected);
    }
  });

  it("derives a readable source name from the tenant label within the name bound", () => {
    expect(deriveSourceName("acme")).toBe("Acme Jira");
    expect(deriveSourceName("my-team")).toBe("My Team Jira");
    expect(deriveSourceName("apcoa-eu")).toBe("Apcoa Eu Jira");
    const long = deriveSourceName("a".repeat(120));
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(80);
    expect(long.endsWith(" Jira")).toBe(true);
  });

  it("accepts a board ID or same-site board URL and rejects cross-site lookups", () => {
    expect(normalizeJiraBoardLookup("310", "https://acme.atlassian.net")).toEqual({ ok: true, boardId: "310" });
    expect(normalizeJiraBoardLookup("https://acme.atlassian.net/jira/software/c/projects/UKIE/boards/310", "https://acme.atlassian.net"))
      .toEqual({ ok: true, boardId: "310" });
    expect(normalizeJiraBoardLookup("https://other.atlassian.net/jira/software/c/projects/UKIE/boards/310", "https://acme.atlassian.net"))
      .toMatchObject({ ok: false, message: expect.stringMatching(/different Jira site/) });
    expect(normalizeJiraBoardLookup("https://acme.atlassian.net/browse/UKIE-310", "https://acme.atlassian.net"))
      .toMatchObject({ ok: false, message: expect.stringMatching(/board URL/) });
  });

  it("merges exact board lookups into the paged options without duplicates", () => {
    expect(mergeBoardOptions(
      [{ id: "84", name: "Payments", kind: "scrum", locationName: null }],
      [
        { id: "310", name: "UK & IE Flow Next", kind: "scrum", locationName: "UKIE" },
        { id: "84", name: "Payments renamed", kind: "kanban", locationName: null },
      ],
    ).map((board) => `${board.id}:${board.name}`)).toEqual([
      "84:Payments renamed",
      "310:UK & IE Flow Next",
    ]);
  });
});

describe("Project New Task automation", () => {
  const configuration = {
    projectId: "project-1",
    createWorktree: true,
    agentId: "codex" as string | null,
    model: "gpt-5.6-sol" as string | null,
    reasoning: "high" as const,
    kickoffMessage: "Implement and verify." as string | null,
  };
  const off = { createWorktree: false, agentId: null, model: null, reasoning: null, kickoffMessage: null } as const;
  const on = {
    createWorktree: true,
    agentId: "codex",
    model: "gpt-5.6-sol",
    reasoning: "high" as const,
    kickoffMessage: "Implement and verify.",
  };

  it("edits the Project default and mirrors the daemon's agent-needs-worktree rule", () => {
    const draft = projectTaskAutomationDraftFrom(configuration);
    expect(draft).toEqual(on);
    expect(projectTaskAutomationChanged(draft, configuration)).toBe(false);
    expect(projectTaskAutomationChanged({ ...draft, agentId: null }, configuration)).toBe(true);
    expect(projectTaskAutomationError(draft)).toBeUndefined();
    expect(projectTaskAutomationError(off)).toBeUndefined();
    expect(projectTaskAutomationError({ ...on, createWorktree: false })).toMatch(/requires worktree/);
    expect(projectTaskAutomationError({ ...on, agentId: "x".repeat(65) })).toMatch(/configured agent/);
    expect(projectTaskAutomationError({ ...on, kickoffMessage: " " })).toMatch(/kickoff message/);
  });

  it("names what a new Task will get", () => {
    expect(taskAutomationSummary(off)).toMatch(/Task only/);
    expect(taskAutomationSummary({ ...off, createWorktree: true })).toMatch(/no agent/);
    expect(taskAutomationSummary(on, "Codex"))
      .toBe("Task, worktree, and Codex · gpt-5.6-sol · high reasoning · kickoff message");
  });

  it("sends a resolved one-shot intent instead of inheriting the Project default", () => {
    expect(taskCreationIntent(on))
      .toEqual({
        worktreeIntent: "provision",
        agentId: "codex",
        model: "gpt-5.6-sol",
        reasoning: "high",
        kickoffMessage: "Implement and verify.",
      });
    expect(taskCreationIntent({ ...off, createWorktree: true }))
      .toEqual({ worktreeIntent: "provision", agentId: null, model: null, reasoning: null, kickoffMessage: null });
    // Unchecked worktree drops the agent with it: the daemon rejects an agent
    // without one, and "none" must never smuggle a Project default back in.
    expect(taskCreationIntent({ ...on, createWorktree: false }))
      .toEqual({ worktreeIntent: "none", agentId: null, model: null, reasoning: null, kickoffMessage: null });
  });

  it("keeps a chosen but unavailable agent visible in the picker", () => {
    const available = [fullAgentCapability("codex")];
    expect(agentChoiceOptions(available, null)).toEqual([{ agentId: "codex", label: "Codex", available: true }]);
    expect(agentChoiceOptions(available, "codex")).toEqual([{ agentId: "codex", label: "Codex", available: true }]);
    expect(agentChoiceOptions([fullAgentCapability("claude", { available: false }), ...available], "claude")).toEqual([
      { agentId: "claude", label: "Claude", available: false },
      { agentId: "codex", label: "Codex", available: true },
    ]);
    expect(agentChoiceOptions([], "retired")).toEqual([{ agentId: "retired", label: "retired", available: false }]);
  });
});
