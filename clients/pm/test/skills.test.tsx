// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { ProposalCard } from "../src/renderer/ui/ProposalCard.js";
import { SkillsPanel, type SkillsPanelProps } from "../src/renderer/ui/SkillsPanel.js";
import { fakeBridge, manifest, ok, proposal, skill, skillDraft, ticket } from "./fixtures.js";
import { render } from "./render.js";

const BOARD = { projectId: "project-1", sprints: [], tickets: [], environments: [], probes: [], runningChecks: [], tracking: { jira: true, code: false, deploy: false, tier: "tickets" } };

function panel(overrides: Partial<SkillsPanelProps> = {}): SkillsPanelProps {
  return {
    skills: { projectId: "project-1", skills: [skill()], drafts: [] },
    tier: "deploy",
    tickets: [ticket()],
    now: 0,
    canCreate: true,
    onSetEnabled: () => undefined,
    onRun: () => undefined,
    onCreate: () => undefined,
    onRevise: () => undefined,
    onSetUp: () => undefined,
    onDryRun: () => undefined,
    onDiscard: () => undefined,
    onInstall: async () => true,
    onOpenLink: () => undefined,
    ...overrides,
  };
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text)!;

describe("SkillsPanel", () => {
  it("ticks a skill off, runs it, and launches the creator", () => {
    const onSetEnabled = vi.fn();
    const onRun = vi.fn();
    const onCreate = vi.fn();
    const { container, unmount } = render(
      <SkillsPanel {...panel({ onSetEnabled, onRun, onCreate, skills: { projectId: "project-1", skills: [skill({ pendingSuggestionCount: 2, runsToday: 3 })], drafts: [] } })} />,
    );
    expect(container.textContent).toContain("2 pending");
    expect(container.textContent).toContain("3 today");
    act(() => container.querySelector<HTMLInputElement>('input[aria-label="Bug owner finder enabled"]')!.click());
    expect(onSetEnabled).toHaveBeenCalledWith("skill-1", false);
    act(() => button(container, "Run now").click());
    expect(onRun).toHaveBeenCalledWith("skill-1");
    act(() => button(container, "Create a skill").click());
    expect(onCreate).toHaveBeenCalled();
    unmount();
  });

  it("shows why a paused skill stopped and when a failed one retries", () => {
    const paused = render(
      <SkillsPanel {...panel({ skills: { projectId: "project-1", skills: [skill({ enabled: false, pausedReason: "Paused after 3 failed runs in a row." })], drafts: [] } })} />,
    );
    expect(paused.container.textContent).toContain("Paused after 3 failed runs in a row.");
    paused.unmount();
    const waiting = render(
      <SkillsPanel {...panel({ now: 1_000, skills: { projectId: "project-1", skills: [skill({ consecutiveFailures: 1, nextAttemptAtEpochMs: 1_000 + 15 * 60_000 })], drafts: [] } })} />,
    );
    expect(waiting.container.textContent).toContain("The last run failed; it tries again in 15m.");
    waiting.unmount();
  });

  it("installs a draft only after a dry run and every first-use tool is ticked", async () => {
    const onInstall = vi.fn(async () => true);
    const draft = skillDraft({ firstUseTools: ["pm_board_read", "pm_risks_read"], samples: [{ ticketId: "ticket-1", change: { kind: "assignee", assignee: "ada", shortlist: [] }, summary: "Ada touched the checkout last.", evidence: [] }] });
    const { container, unmount } = render(<SkillsPanel {...panel({ onInstall, skills: { projectId: "project-1", skills: [], drafts: [draft] } })} />);
    expect(container.textContent).toContain("Ada touched the checkout last.");
    const install = button(container, "Install");
    expect(install.disabled).toBe(true);
    expect(container.textContent).toContain("Approve each new tool first.");
    const ticks = [...container.querySelectorAll<HTMLInputElement>(".tool-approvals input")];
    act(() => ticks[0]!.click());
    expect(install.disabled).toBe(true);
    act(() => ticks[1]!.click());
    expect(install.disabled).toBe(false);
    await act(async () => install.click());
    expect(onInstall).toHaveBeenCalledWith("draft-1", ["pm_board_read", "pm_risks_read"], []);
    unmount();
  });

  it("asks for the agent's own Slack tool and at least one ticked channel", async () => {
    const onInstall = vi.fn(async () => true);
    const slackTool = "mcp__claude_ai_Slack__slack_read_channel";
    const base = skillDraft();
    const draft = skillDraft({
      firstUseTools: [slackTool],
      manifest: { ...base.manifest, sources: ["slack"], prefilter: "slackMentions", agentTools: [slackTool], channels: [{ id: "C0SHOP", name: "shop" }, { id: "C0OPS", name: "ops" }] },
    });
    const { container, unmount } = render(<SkillsPanel {...panel({ onInstall, skills: { projectId: "project-1", skills: [], drafts: [draft] } })} />);
    expect(container.textContent).toContain("Your agent's slack_read_channel");
    expect(container.textContent).toContain("#shop");
    const [toolTick, shopTick, opsTick] = [...container.querySelectorAll<HTMLInputElement>(".tool-approvals input")];
    const install = button(container, "Install");
    act(() => toolTick!.click());
    expect(install.disabled).toBe(false);
    act(() => shopTick!.click());
    act(() => opsTick!.click());
    expect(install.disabled).toBe(true);
    act(() => opsTick!.click());
    await act(async () => install.click());
    expect(onInstall).toHaveBeenCalledWith("draft-1", [slackTool], ["C0OPS"]);
    unmount();
  });

  it("offers a revision when most suggestions were rejected, and on demand", () => {
    const onRevise = vi.fn();
    const plain = render(<SkillsPanel {...panel({ onRevise })} />);
    act(() => button(plain.container, "Revise").click());
    expect(onRevise).toHaveBeenCalledWith("skill-1");
    plain.unmount();
    const builtin = render(<SkillsPanel {...panel({ skills: { projectId: "project-1", skills: [skill({ builtin: "deploymentControl" })], drafts: [] } })} />);
    expect(button(builtin.container, "Revise")).toBeUndefined();
    builtin.unmount();
    const offered = render(
      <SkillsPanel {...panel({ onRevise, skills: { projectId: "project-1", skills: [skill({ revisionReason: "You rejected 13 of its last 20 suggestions." })], drafts: [] } })} />,
    );
    expect(offered.container.querySelector(".revision-offer")?.textContent).toContain("You rejected 13 of its last 20 suggestions.");
    expect([...offered.container.querySelectorAll("button")].filter((candidate) => candidate.textContent === "Revise")).toHaveLength(1);
    offered.unmount();
  });

  it("compares a revision with the installed version before it installs as the next one", () => {
    const installed = skill({ version: 3 });
    const draft = skillDraft({
      origin: "revision",
      baseSkillId: "skill-1",
      changelog: "Skips bugs that already have an owner.",
      manifest: { ...installed.manifest, instructions: "Suggest an owner only for unassigned bugs." },
    });
    const { container, unmount } = render(<SkillsPanel {...panel({ skills: { projectId: "project-1", skills: [installed], drafts: [draft] } })} />);
    expect(container.textContent).toContain("Skill revision");
    expect(container.textContent).toContain("What changed: Skips bugs that already have an owner.");
    const diff = container.querySelector('[aria-label="Changes from v3"]')!;
    expect(diff.querySelector(".diff-line.removed")?.textContent).toBe("Suggest an owner.");
    expect(diff.querySelector(".diff-line.added")?.textContent).toBe("Suggest an owner only for unassigned bugs.");
    expect(button(container, "Install as v4")).toBeDefined();
    unmount();
  });

  it("starts the creator in revise mode for one skill", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_skill_creator_launch") return ok({ sessionId: "session-1" });
      return ok({ projectId: "project-1", sessions: [] });
    });
    await new PmController(bridge, createPmStore({ projectId: "project-1" })).launchSkillCreator({ skillId: "skill-1" });
    expect(bridge.calls[0]).toEqual({ method: "pm_skill_creator_launch", params: { projectId: "project-1", skillId: "skill-1" } });
  });

  it("lists every known skill greyed out with its own Set up", () => {
    const onSetUp = vi.fn();
    const empty = render(<SkillsPanel {...panel({ onSetUp, skills: { projectId: "project-1", skills: [], drafts: [] } })} />);
    const rows = [...empty.container.querySelectorAll(".skill-row.setup")];
    expect(rows.map((row) => row.querySelector(".skill-name")?.textContent)).toEqual(["Deployment control", "Bug owner finder", "Slack tracker"]);
    expect(rows.every((row) => row.querySelector<HTMLInputElement>("input")!.disabled)).toBe(true);
    act(() => rows[2]!.querySelector("button")!.click());
    expect(onSetUp).toHaveBeenCalledWith("slackTracker");
    empty.unmount();
    const set = render(
      <SkillsPanel {...panel({ skills: { projectId: "project-1", skills: [skill(), skill({ id: "skill-2", builtin: "deploymentControl", enabled: false })], drafts: [skillDraft({ manifest: manifest({ prefilter: "slackMentions" }) })] } })} />,
    );
    const setup = [...set.container.querySelectorAll(".skill-row.setup")];
    expect(setup.map((row) => row.querySelector(".skill-name")?.textContent)).toEqual(["Deployment control", "Slack tracker"]);
    expect(setup[1]!.textContent).toContain("A draft is waiting below.");
    expect(setup[1]!.querySelector("button")!.disabled).toBe(true);
    set.unmount();
  });

  it("sets up each skill with its own creator, and Deployment control in place", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_skill_creator_launch") return ok({ sessionId: "session-1" });
      return ok({ projectId: "project-1", sessions: [] });
    });
    const store = createPmStore({ projectId: "project-1" });
    const controller = new PmController(bridge, store);
    await controller.setUpSkill("bugOwnerFinder");
    expect(bridge.calls[0]).toEqual({ method: "pm_skill_creator_launch", params: { projectId: "project-1", setup: "bugOwnerFinder" } });
    await controller.setUpSkill("deploymentControl");
    expect(store.getState().view).toBe("settings");
  });

  it("keeps Install off until the dry run completed", () => {
    const draft = skillDraft({ dryRunState: "none", firstUseTools: [] });
    const onDryRun = vi.fn();
    const { container, unmount } = render(<SkillsPanel {...panel({ onDryRun, skills: { projectId: "project-1", skills: [], drafts: [draft] } })} />);
    expect(button(container, "Install").disabled).toBe(true);
    act(() => button(container, "Dry run").click());
    expect(onDryRun).toHaveBeenCalledWith("draft-1");
    unmount();
  });
});

describe("skill suggestions", () => {
  it("assigns the shortlisted person the PM picks", () => {
    const onAccept = vi.fn();
    const suggestion = proposal({
      skillId: "skill-1",
      skillVersion: 1,
      change: { kind: "assignee", assignee: "ada", shortlist: [
        { name: "ada", reason: "Changed checkout last", evidence: [] },
        { name: "lin", reason: "Reviewed the last fix", evidence: [] },
      ] },
    });
    const { container, unmount } = render(
      <ProposalCard proposal={suggestion} ticket={ticket()} headVersion={2} now={0} sprintName={() => "Sprint 12"} onAccept={onAccept} onReject={() => undefined} onOpenLink={() => undefined} />,
    );
    expect(container.textContent).toContain("Skill suggestion");
    act(() => button(container, "Assign lin").click());
    expect(onAccept).toHaveBeenCalledWith("lin");
    unmount();
  });

  it("opens the Jira diff after accepting a change Jira should see, and never applies it", async () => {
    const comment = proposal({ id: "proposal-2", skillId: "skill-1", skillVersion: 1, change: { kind: "jiraComment", body: "Blocked on the API." } });
    const bridge = fakeBridge((method) => {
      if (method === "pm_ticket_proposal_accept") return ok(ticket());
      if (method === "pm_ticket_proposals_read") return ok({ ticketId: "ticket-1", proposals: [] });
      if (method === "pm_board_read") return ok(BOARD);
      if (method === "pm_digest_read") return ok({ projectId: "project-1", entries: [] });
      if (method === "pm_jira_diff_read") return ok({ ticketId: "ticket-1", issueKey: "SHOP-7", jiraUpdated: null, ticketVersion: 2, changes: [], statusUnreachable: false, token: "t" });
      return ok({});
    });
    const store = createPmStore({ projectId: "project-1", proposals: { "ticket-1": [comment] } });
    await new PmController(bridge, store).acceptProposal("ticket-1", "proposal-2");
    const methods = bridge.calls.map((call) => call.method);
    expect(methods).toContain("pm_jira_diff_read");
    expect(methods).not.toContain("pm_jira_apply");
    expect(store.getState().jiraDialog?.ticketId).toBe("ticket-1");
  });

  it("does not open the Jira diff for a PM-only change", async () => {
    const criteria = proposal({ change: { kind: "acceptanceCriteria", criteria: ["Works offline"] } });
    const bridge = fakeBridge((method) => {
      if (method === "pm_ticket_proposal_accept") return ok(ticket());
      if (method === "pm_ticket_proposals_read") return ok({ ticketId: "ticket-1", proposals: [] });
      if (method === "pm_board_read") return ok(BOARD);
      if (method === "pm_digest_read") return ok({ projectId: "project-1", entries: [] });
      return ok({});
    });
    const store = createPmStore({ projectId: "project-1", proposals: { "ticket-1": [criteria] } });
    await new PmController(bridge, store).acceptProposal("ticket-1", "proposal-1");
    expect(bridge.calls.map((call) => call.method)).not.toContain("pm_jira_diff_read");
  });
});
