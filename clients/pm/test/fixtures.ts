import type { PmBoardTicket, PmJiraDiff, PmProposal, PmSkill, PmSkillDraft, PmSkillManifest, PmSprint, PmTicket } from "@termloop/pm-contract/pm";
import type { PmApi, PmCallOutcome, RendererMethod } from "../src/pm-api.js";

export function sprint(overrides: Partial<PmSprint> = {}): PmSprint {
  return {
    id: "sprint-1", projectId: "project-1", name: "Sprint 12", goal: "Ship checkout", state: "active",
    createdAtEpochMs: 0, activatedAtEpochMs: 0, closedAtEpochMs: null, endsAtEpochMs: null,
    jiraSprintId: null, jiraBoardId: null, jiraPulledAtEpochMs: null, ...overrides,
  };
}

export function ticket(overrides: Partial<PmTicket> = {}): PmTicket {
  return {
    id: "ticket-1", projectId: "project-1", title: "Checkout button", description: "Old text", status: "inProgress",
    priority: "medium", assignee: "ada", sprintId: "sprint-1", rank: 1, jiraUrl: "https://acme.atlassian.net/browse/SHOP-7",
    jiraSprintId: null, jiraPulledAtEpochMs: null, carryOverCount: 0, blockers: [], acceptanceCriteria: [],
    versions: { count: 2, headNumber: 2, headAuthor: "pm", headRecordedAtEpochMs: 0 }, createdAtEpochMs: 0, updatedAtEpochMs: 0,
    ...overrides,
  };
}

export function boardTicket(overrides: Partial<PmTicket> = {}, delivery: Partial<PmBoardTicket["delivery"]> = {}): PmBoardTicket {
  const value = ticket(overrides);
  return {
    ticket: value,
    delivery: {
      ticketId: value.id, stage: { kind: "merged", environment: null, sinceEpochMs: null }, risks: [],
      checkReasons: [], facts: null, checking: false, ...delivery,
    },
    pendingProposalCount: 0,
  };
}

export function jiraDiff(overrides: Partial<PmJiraDiff> = {}): PmJiraDiff {
  return {
    ticketId: "ticket-1", issueKey: "SHOP-7", jiraUpdated: "2026-10-25T10:00:00Z", ticketVersion: 2,
    changes: [{ field: "summary", jira: "Old summary", ticket: "Checkout button" }], statusUnreachable: false, token: "diff-token-1",
    ...overrides,
  };
}

type Responder = (method: RendererMethod, params: unknown) => PmCallOutcome<RendererMethod>;

/** A recording `window.pm` double; terminal methods are inert. */
export function fakeBridge(respond: Responder): PmApi & { calls: { method: RendererMethod; params: unknown }[] } {
  const calls: { method: RendererMethod; params: unknown }[] = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      return respond(method, params) as never;
    },
    connectionState: async () => ({ state: "connected", version: "test" }) as never,
    onConnectionState: () => () => undefined,
    onEvent: () => () => undefined,
    openExternal: async () => undefined,
    pickFolder: async () => null,
    onNativeShortcut: () => () => undefined,
    terminalRenderer: "xterm",
    ghostty: new Proxy({} as PmApi["ghostty"], { get: () => () => { throw new Error("ghostty is not available in tests"); } }),
    terminal: {
      attach: async () => undefined,
      detach: () => undefined,
      input: () => undefined,
      resize: () => undefined,
      credit: () => undefined,
      onMessage: () => () => undefined,
    },
  };
}

export const ok = (result: unknown) => ({ ok: true, result }) as PmCallOutcome<RendererMethod>;

export function manifest(overrides: Partial<PmSkillManifest> = {}): PmSkillManifest {
  return {
    name: "Bug owner finder", description: "Suggests who should own a new bug.", trigger: { kind: "manual" },
    sources: ["board"], prefilter: "bugTickets", approvedTools: ["pm_board_read"], instructions: "Suggest an owner.", channels: [],
    ...overrides,
  };
}

export function skill(overrides: Partial<PmSkill> = {}): PmSkill {
  return {
    id: "skill-1", projectId: "project-1", builtin: null, enabled: true, version: 1, manifest: manifest(),
    lastRunAtEpochMs: null, lastOutcome: null, running: false, pendingSuggestionCount: 0, runsToday: 0,
    consecutiveFailures: 0, pausedReason: null, createdAtEpochMs: 0, ...overrides,
  };
}

export function skillDraft(overrides: Partial<PmSkillDraft> = {}): PmSkillDraft {
  return {
    id: "draft-1", projectId: "project-1", origin: "creator", baseSkillId: null, manifest: manifest(),
    whatItWillDo: "Suggests an owner for each new bug.", neededTools: [], firstUseTools: ["pm_board_read"], changelog: null,
    dryRunState: "completed", dryRunAtEpochMs: 0, samples: [], createdAtEpochMs: 0, ...overrides,
  };
}

export function proposal(overrides: Partial<PmProposal> = {}): PmProposal {
  return {
    id: "proposal-1", ticketId: "ticket-1", change: { kind: "description", description: "New text" }, summary: "Clearer",
    baseVersion: 2, skillId: null, skillVersion: null, evidence: [], createdAtEpochMs: 0, ...overrides,
  };
}
