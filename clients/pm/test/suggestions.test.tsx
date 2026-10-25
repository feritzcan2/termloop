// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { SuggestionsPanel, type SuggestionsPanelProps } from "../src/renderer/ui/SuggestionsPanel.js";
import { boardTicket, fakeBridge, manifest, ok, proposal, skill, ticket } from "./fixtures.js";
import { render } from "./render.js";

const BOARD = { projectId: "project-1", sprints: [], tickets: [], environments: [], probes: [], runningChecks: [], tracking: { jira: true, code: false, deploy: false, tier: "tickets" } };

const blockers = proposal({ id: "p-1", skillId: "skill-1", skillVersion: 1, change: { kind: "blockers", blockers: ["Waiting on the API"] }, summary: "Blocked in standup" });
const comment = proposal({ id: "p-2", skillId: "skill-2", skillVersion: 1, change: { kind: "jiraComment", body: "Blocked on the API." }, summary: "Tell Jira" });
const other = proposal({ id: "p-3", ticketId: "ticket-2", skillId: "skill-1", skillVersion: 1, change: { kind: "status", status: "done" }, summary: "Shipped" });

function panel(overrides: Partial<SuggestionsPanelProps> = {}): SuggestionsPanelProps {
  return {
    suggestions: [blockers, comment, other],
    tickets: [boardTicket(), boardTicket({ id: "ticket-2", title: "Refund page", jiraUrl: null })],
    sprints: [],
    skills: [skill(), skill({ id: "skill-2", manifest: { ...manifest(), name: "Slack tracker" } })],
    now: 0,
    onAccept: () => undefined,
    onReject: () => undefined,
    onAcceptAll: () => undefined,
    onOpenTicket: () => undefined,
    onOpenLink: () => undefined,
    ...overrides,
  };
}

const button = (container: Element, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text)!;

describe("SuggestionsPanel", () => {
  it("groups suggestions by ticket and tags each with its skill", () => {
    const { container, unmount } = render(<SuggestionsPanel {...panel()} />);
    const groups = [...container.querySelectorAll(".suggestion-group")];
    expect(groups.map((group) => group.querySelectorAll(".draft-card").length)).toEqual([2, 1]);
    expect(groups[0]!.textContent).toContain("SHOP-7");
    expect(groups[0]!.textContent).toContain("Bug owner finder");
    expect(groups[0]!.textContent).toContain("Slack tracker");
    expect(groups[1]!.textContent).toContain("Refund page");
    // One suggestion has nothing to accept in bulk.
    expect(groups[1]!.textContent).not.toContain("Accept all");
    unmount();
  });

  it("accepts, rejects, accepts all and opens the ticket", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const onAcceptAll = vi.fn();
    const onOpenTicket = vi.fn();
    const { container, unmount } = render(<SuggestionsPanel {...panel({ onAccept, onReject, onAcceptAll, onOpenTicket })} />);
    const [first, second] = [...container.querySelectorAll(".suggestion-group")];
    const cards = [...first!.querySelectorAll(".draft-card")];
    act(() => button(cards[0]!, "Apply").click());
    expect(onAccept).toHaveBeenCalledWith("ticket-1", "p-1", undefined);
    act(() => button(cards[1]!, "Dismiss").click());
    expect(onReject).toHaveBeenCalledWith("ticket-1", "p-2");
    act(() => button(first!, "Accept all 2").click());
    expect(onAcceptAll).toHaveBeenCalledWith("ticket-1");
    act(() => second!.querySelector<HTMLButtonElement>(".suggestion-group-head .link")!.click());
    expect(onOpenTicket).toHaveBeenCalledWith("ticket-2");
    unmount();
  });

  it("says when nothing is waiting", () => {
    const { container, unmount } = render(<SuggestionsPanel {...panel({ suggestions: [] })} />);
    expect(container.textContent).toContain("No suggestions waiting.");
    unmount();
  });
});

describe("suggestion inbox actions", () => {
  function bridgeFor(accept: (proposalId: string) => ReturnType<typeof ok>) {
    return fakeBridge((method, params) => {
      if (method === "pm_ticket_proposal_accept") return accept((params as { proposalId: string }).proposalId);
      if (method === "pm_ticket_proposals_read") return ok({ ticketId: "ticket-1", proposals: [] });
      if (method === "pm_skill_suggestions_read") return ok({ projectId: "project-1", proposals: [] });
      if (method === "pm_board_read") return ok(BOARD);
      if (method === "pm_digest_read") return ok({ projectId: "project-1", entries: [] });
      if (method === "pm_jira_diff_read") return ok({ ticketId: "ticket-1", issueKey: "SHOP-7", jiraUpdated: null, ticketVersion: 2, changes: [], statusUnreachable: false, token: "t" });
      return ok({});
    });
  }

  it("accepts a ticket's suggestions in order and opens the Jira diff once", async () => {
    const bridge = bridgeFor(() => ok(ticket()));
    const store = createPmStore({ projectId: "project-1", suggestions: [blockers, comment, other] });
    await new PmController(bridge, store).acceptAllSuggestions("ticket-1");
    const accepted = bridge.calls.filter((call) => call.method === "pm_ticket_proposal_accept").map((call) => (call.params as { proposalId: string }).proposalId);
    expect(accepted).toEqual(["p-1", "p-2"]);
    expect(bridge.calls.filter((call) => call.method === "pm_jira_diff_read")).toHaveLength(1);
    expect(bridge.calls.map((call) => call.method)).not.toContain("pm_jira_apply");
    expect(store.getState().jiraDialog?.ticketId).toBe("ticket-1");
    expect(store.getState().suggestions).toEqual([]);
  });

  it("stops at the first refusal and opens no Jira diff for what was not accepted", async () => {
    const bridge = bridgeFor((proposalId) => proposalId === "p-1"
      ? ({ ok: false, error: { code: "constraint", message: "Outdated" } }) as ReturnType<typeof ok>
      : ok(ticket()));
    const store = createPmStore({ projectId: "project-1", suggestions: [blockers, comment] });
    await new PmController(bridge, store).acceptAllSuggestions("ticket-1");
    expect(bridge.calls.filter((call) => call.method === "pm_ticket_proposal_accept")).toHaveLength(1);
    expect(bridge.calls.map((call) => call.method)).not.toContain("pm_jira_diff_read");
    expect(store.getState().notice?.text).toBe("Outdated");
  });

  it("opens the Jira diff when a single Jira-touching suggestion is accepted from the inbox", async () => {
    const bridge = bridgeFor(() => ok(ticket()));
    const store = createPmStore({ projectId: "project-1", suggestions: [comment] });
    await new PmController(bridge, store).acceptProposal("ticket-1", "p-2");
    expect(store.getState().jiraDialog?.ticketId).toBe("ticket-1");
  });
});
