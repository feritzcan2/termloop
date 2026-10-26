import { describe, expect, it } from "vitest";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { fakeBridge, jiraDiff, ok, ticket } from "./fixtures.js";

describe("PmController", () => {
  it("accepts an agent proposal only through pm_ticket_proposal_accept", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_ticket_proposals_read") return ok({ proposals: [] });
      if (method === "pm_board_read") return ok({ projectId: "project-1", sprints: [], tickets: [], environments: [], probes: [], runningChecks: [], epics: [], epicBreakdowns: [], tracking: { jira: false, code: false, deploy: false, tier: "tickets" } });
      return ok({});
    });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    await controller.acceptProposal("ticket-1", "proposal-9");
    expect(bridge.calls[0]).toEqual({ method: "pm_ticket_proposal_accept", params: { proposalId: "proposal-9" } });
    expect(bridge.calls.map((call) => call.method)).not.toContain("pm_jira_apply");
  });

  it("sets and clears the project's code folder and keeps the returned project", async () => {
    const bridge = fakeBridge((method, params) => {
      if (method === "pm_project_update") {
        const { folder } = params as { folder: string | null };
        return ok({ id: "project-1", name: "Shop", folder, createdAtEpochMs: 1 });
      }
      return ok({});
    });
    const store = createPmStore({ projectId: "project-1", projects: [{ id: "project-1", name: "Shop", folder: null, createdAtEpochMs: 1 }] });
    const controller = new PmController(bridge, store);
    await controller.setProjectFolder("/work/shop");
    expect(bridge.calls[0]).toEqual({ method: "pm_project_update", params: { projectId: "project-1", folder: "/work/shop" } });
    expect(store.getState().projects[0]?.folder).toBe("/work/shop");
    await controller.setProjectFolder(null);
    expect(store.getState().projects[0]?.folder).toBeNull();
  });

  it("deletes the open project and opens the first remaining one, or none", async () => {
    const shop = { id: "project-1", name: "Shop", folder: null, createdAtEpochMs: 1 };
    const search = { id: "project-2", name: "Search", folder: null, createdAtEpochMs: 2 };
    const bridge = fakeBridge((method) => {
      if (method === "pm_project_delete") return ok({ deleted: true });
      return { ok: false, error: { code: "unavailable", message: "offline" } };
    });
    const store = createPmStore({ projectId: "project-1", projects: [shop, search] });
    const controller = new PmController(bridge, store);
    await controller.deleteProject();
    expect(bridge.calls[0]).toEqual({ method: "pm_project_delete", params: { projectId: "project-1" } });
    expect(store.getState()).toMatchObject({ projectId: "project-2", projects: [search] });
    bridge.calls.length = 0;
    await controller.deleteProject();
    expect(store.getState()).toMatchObject({ projectId: undefined, projects: [], board: undefined });
    // With no project left there is nothing to read.
    expect(bridge.calls.map((call) => call.method)).toEqual(["pm_project_delete"]);
  });

  it("deletes a sprint, unfocuses it, and rereads the board", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_sprint_delete") return ok({ sprint: { name: "Sprint 12" }, movedTicketIds: ["t1", "t2"] });
      return { ok: false, error: { code: "unavailable", message: "offline" } };
    });
    const store = createPmStore({ projectId: "project-1", selectedSprintId: "sprint-1" });
    await new PmController(bridge, store).deleteSprint("sprint-1");
    expect(bridge.calls[0]).toEqual({ method: "pm_sprint_delete", params: { sprintId: "sprint-1" } });
    expect(bridge.calls.map((call) => call.method)).toContain("pm_board_read");
    expect(store.getState().selectedSprintId).toBeUndefined();
  });

  it("shows Jira's fresh diff when apply finds the shown diff stale", async () => {
    const fresh = jiraDiff({ token: "diff-token-2", changes: [{ field: "summary", jira: "Renamed in Jira", ticket: "Checkout button" }] });
    const bridge = fakeBridge((method) => {
      if (method === "pm_jira_diff_read") return ok(jiraDiff());
      if (method === "pm_jira_apply") return ok({ kind: "stale", diff: fresh });
      return ok({});
    });
    const store = createPmStore({ projectId: "project-1" });
    const controller = new PmController(bridge, store);
    await controller.openJiraDialog("ticket-1");
    await controller.applyJira();
    expect(bridge.calls.find((call) => call.method === "pm_jira_apply")?.params).toEqual({ ticketId: "ticket-1", token: "diff-token-1" });
    expect(store.getState().jiraDialog).toMatchObject({ diff: fresh, staleNotice: true, result: undefined, loading: false });
  });

  it("reads the board's Jira sprints, or the boards to choose from when none is chosen", async () => {
    const jira = { siteUrl: "https://acme.atlassian.net", boardId: null, accountEmail: "pm@acme.test", credentialHandle: "handle-1" };
    const sprints = { projectId: "project-1", boardId: 310, sprintsSupported: true, truncated: false, sprints: [] };
    const boards = { projectId: "project-1", truncated: false, boards: [{ id: 310, name: "UK", kind: "scrum", location: null }] };
    const bridge = fakeBridge((method, params) => {
      if (method === "pm_jira_boards_read") return ok(boards);
      if (method === "pm_jira_sprints_read") return ok(sprints);
      if (method === "pm_sources_set") return ok({ projectId: "project-1", jira: (params as { jira: unknown }).jira, github: null, azureDevOps: null });
      return { ok: false, error: { code: "unavailable", message: "offline" } };
    });
    const store = createPmStore({ projectId: "project-1", sources: { projectId: "project-1", jira, github: null, azureDevOps: null } });
    const controller = new PmController(bridge, store);
    await controller.loadJiraSprints();
    expect(store.getState().jiraSprints).toMatchObject({ loading: false, boards, sprints: undefined });
    await controller.setJiraBoard(310);
    // Only the board changes; the token stays a handle.
    expect(bridge.calls.find((call) => call.method === "pm_sources_set")?.params).toEqual({ projectId: "project-1", jira: { ...jira, boardId: 310 } });
    expect(store.getState().jiraSprints).toMatchObject({ loading: false, sprints, boards: undefined });
    await controller.loadJiraSprints(true);
    expect(store.getState().jiraSprints).toMatchObject({ boards, sprints });
    expect(bridge.calls.map((call) => call.method).filter((method) => method.startsWith("pm_jira"))).toEqual([
      "pm_jira_boards_read", "pm_jira_sprints_read", "pm_jira_boards_read",
    ]);
  });

  it("shows a failed Jira sprint read in the panel, not as a notice", async () => {
    const jira = { siteUrl: "https://acme.atlassian.net", boardId: 310, accountEmail: "pm@acme.test", credentialHandle: "handle-1" };
    const bridge = fakeBridge(() => ({ ok: false, error: { code: "operationFailed", message: "Jira refused the token." } }));
    const store = createPmStore({ projectId: "project-1", sources: { projectId: "project-1", jira, github: null, azureDevOps: null } });
    await new PmController(bridge, store).loadJiraSprints();
    expect(store.getState()).toMatchObject({ notice: undefined, jiraSprints: { loading: false, error: "Jira refused the token." } });
  });

  it("imports a Jira sprint, opens it, and rereads the board and the Jira sprints", async () => {
    const jira = { siteUrl: "https://acme.atlassian.net", boardId: 310, accountEmail: "pm@acme.test", credentialHandle: "handle-1" };
    const bridge = fakeBridge((method) => {
      if (method === "pm_jira_sprint_import") {
        return ok({ projectId: "project-1", outcome: { kind: "applied", sprintId: "sprint-9", ticketsCreated: ["t1", "t2"], ticketsMoved: [], skipped: 0 } });
      }
      return { ok: false, error: { code: "unavailable", message: "offline" } };
    });
    const store = createPmStore({ projectId: "project-1", sources: { projectId: "project-1", jira, github: null, azureDevOps: null } });
    const notices: string[] = [];
    store.subscribe((state) => { if (state.notice) notices.push(state.notice.text); });
    await new PmController(bridge, store).importJiraSprint(7919);
    expect(bridge.calls[0]).toEqual({ method: "pm_jira_sprint_import", params: { projectId: "project-1", jiraSprintId: 7919 } });
    expect(store.getState().selectedSprintId).toBe("sprint-9");
    expect(notices).toContain("Jira sprint imported: 2 new, 0 moved.");
    expect(store.getState().jiraSprints?.importing).toBeUndefined();
    expect(bridge.calls.map((call) => call.method)).toEqual(expect.arrayContaining(["pm_board_read", "pm_jira_sprints_read"]));
  });

  it("stores a typed Jira token in the credential store and sends only its handle with the sources", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_credential_store") return ok({ credentialHandle: "handle-1" });
      if (method === "pm_sources_set") return ok({ projectId: "project-1", jira: null, github: null, azureDevOps: null });
      if (method === "pm_board_read") return { ok: false, error: { code: "unavailable", message: "offline" } };
      return ok({});
    });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    await controller.saveSources({ siteUrl: "https://acme.atlassian.net", boardId: 3, accountEmail: "pm@acme.test", token: "s3cret" });
    expect(bridge.calls[0]).toEqual({ method: "pm_credential_store", params: { kind: "jiraApiToken", secret: "s3cret" } });
    const sourcesCall = bridge.calls.find((call) => call.method === "pm_sources_set");
    expect(JSON.stringify(sourcesCall?.params)).not.toContain("s3cret");
    expect(sourcesCall?.params).toEqual({ projectId: "project-1", jira: expect.objectContaining({ credentialHandle: "handle-1" }) });
  });

  it("rereads the sources after a folder change, which the daemon reads the code host from", async () => {
    const github = { projectId: "project-1", jira: null, github: { owner: "acme", name: "shop" }, azureDevOps: null };
    const bridge = fakeBridge((method) => {
      if (method === "pm_project_update") return ok({ id: "project-1", name: "Shop", folder: "/work/shop", createdAtEpochMs: 0 });
      if (method === "pm_sources_read") return ok(github);
      return { ok: false, error: { code: "unavailable", message: "offline" } };
    });
    const store = createPmStore({ projectId: "project-1" });
    await new PmController(bridge, store).setProjectFolder("/work/shop");
    expect(store.getState().sources).toEqual(github);
  });

  it("rereads the digest with every board reread, so board changes reach Since yesterday", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_board_read") return ok({ projectId: "project-1", sprints: [], tickets: [], environments: [], probes: [], runningChecks: [], epics: [], epicBreakdowns: [], tracking: { jira: false, code: false, deploy: false, tier: "tickets" } });
      if (method === "pm_digest_read") return ok({ projectId: "project-1", sinceEpochMs: 0, untilEpochMs: 1, entries: [], truncated: false });
      return ok({});
    });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }), () => 2 * 86_400_000);
    controller.handleEvent({ event: "pmBoardChanged", payload: { projectId: "project-1" } });
    await controller.refreshBoard();
    const digestReads = bridge.calls.filter((call) => call.method === "pm_digest_read");
    expect(digestReads.length).toBeGreaterThan(0);
    for (const call of digestReads) expect(call.params).toEqual({ projectId: "project-1", sinceEpochMs: 86_400_000 });
  });

  it("sends a sidebar reorder as pm_ticket_move with the lane index", async () => {
    const bridge = fakeBridge((method) => method === "pm_ticket_move" ? ok({}) : { ok: false, error: { code: "unavailable", message: "offline" } });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    await controller.moveTicket("ticket-1", "sprint-1", 2);
    await controller.moveTicket("ticket-1", null);
    expect(bridge.calls.filter((call) => call.method === "pm_ticket_move").map((call) => call.params)).toEqual([
      { ticketId: "ticket-1", sprintId: "sprint-1", index: 2 },
      { ticketId: "ticket-1", sprintId: null },
    ]);
  });

  it("shows a launched or picked agent in the stage and leaves it when the agent exits", async () => {
    const session = { sessionId: "agent-1", projectId: "project-1", mode: "assistant", provider: "claude", focusTicketId: "ticket-1", checkId: null, skillId: null, state: "running", startedAtEpochMs: 0, exitedAtEpochMs: null };
    let sessions = [session];
    const bridge = fakeBridge((method) => {
      if (method === "pm_agent_launch") return ok(session);
      if (method === "pm_agent_list") return ok({ sessions });
      return ok({});
    });
    const store = createPmStore({ projectId: "project-1", view: "ticket", selectedTicketId: "ticket-1" });
    const controller = new PmController(bridge, store);
    await controller.launchAgent("ticket-1");
    expect(store.getState()).toMatchObject({ view: "agent", activeAgentSessionId: "agent-1" });
    controller.setView("ticket");
    controller.selectAgent("agent-1");
    expect(store.getState().view).toBe("agent");
    sessions = [];
    await controller.refreshAgents();
    expect(store.getState()).toMatchObject({ view: "ticket", activeAgentSessionId: undefined });
  });

  it("plans an epic and starts a new conversation through the assistant launch", async () => {
    const session = { sessionId: "agent-1", projectId: "project-1", mode: "assistant", provider: "claude", focusTicketId: null, checkId: null, skillId: null, state: "running", startedAtEpochMs: 0, exitedAtEpochMs: null };
    const bridge = fakeBridge((method) => {
      if (method === "pm_agent_launch") return ok(session);
      if (method === "pm_agent_list") return ok({ sessions: [session], resumable: false });
      return ok({});
    });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    await controller.planEpic("epic-1");
    await controller.planEpic();
    await controller.newConversation(undefined);
    expect(bridge.calls.filter((call) => call.method === "pm_agent_launch").map((call) => call.params)).toEqual([
      { projectId: "project-1", task: "planEpic", epicId: "epic-1" },
      { projectId: "project-1", task: "planEpic" },
      { projectId: "project-1", fresh: true },
    ]);
  });

  it("accepts the kept tasks of a breakdown into the chosen sprint", async () => {
    const epic = { id: "epic-1", projectId: "project-1", title: "Checkout", description: "", createdAtEpochMs: 0, updatedAtEpochMs: 0 };
    const board = { projectId: "project-1", sprints: [], tickets: [], runningChecks: [], epics: [epic], epicBreakdowns: [], tracking: { jira: false, code: false, deploy: false, tier: "tickets" } };
    const bridge = fakeBridge((method) => {
      if (method === "pm_epic_breakdown_accept") return ok({ epic, tickets: [ticket({ epicId: "epic-1" })] });
      if (method === "pm_board_read") return ok(board);
      return ok({});
    });
    const store = createPmStore({ projectId: "project-1" });
    const controller = new PmController(bridge, store);
    expect(await controller.acceptBreakdown("breakdown-1", [0, 2], "sprint-1")).toBe(true);
    expect(await controller.acceptBreakdown("breakdown-1", [1], null)).toBe(true);
    expect(bridge.calls.filter((call) => call.method === "pm_epic_breakdown_accept").map((call) => call.params)).toEqual([
      { breakdownId: "breakdown-1", taskIndices: [0, 2], sprintId: "sprint-1" },
      { breakdownId: "breakdown-1", taskIndices: [1] },
    ]);
    expect(store.getState().notice?.text).toBe("1 ticket(s) created under Checkout.");
  });

  it("loads the agent catalog with the settings", async () => {
    const catalog = { providers: [{ id: "claude", label: "Claude", models: ["default"], permissions: { assistant: ["default"], check: ["bypassPermissions"] } }] };
    const bridge = fakeBridge((method) => method === "pm_agent_catalog_read" ? ok(catalog) : ok({}));
    const store = createPmStore({ projectId: "project-1" });
    await new PmController(bridge, store).loadSettings();
    expect(store.getState().catalog).toEqual(catalog);
  });
  it("records a note and asks the project's one assistant for a description update without changing the ticket", async () => {
    const note = { id: "note-1", ticketId: "ticket-1", kind: "fact", text: "CSV too", url: null, sourceKey: null, author: "pm", createdAtEpochMs: 1, pending: true };
    const session = (sessionId: string) => ({ sessionId, projectId: "project-1", mode: "assistant", provider: "claude", focusTicketId: "ticket-1", checkId: null, skillId: null, state: "running", startedAtEpochMs: 0, exitedAtEpochMs: null });
    // The daemon keeps one assistant per project: every launch reaches it.
    const live: ReturnType<typeof session>[] = [];
    const bridge = fakeBridge((method) => {
      if (method === "pm_ticket_note_add") return ok(note);
      if (method === "pm_ticket_notes_read") return ok({ ticketId: "ticket-1", notes: [note] });
      if (method === "pm_agent_launch") {
        if (live.length === 0) live.push(session("agent-1"));
        return ok(live[0]);
      }
      if (method === "pm_agent_list") return ok({ sessions: live, resumable: true });
      return ok({});
    });
    const store = createPmStore({ projectId: "project-1", view: "ticket", selectedTicketId: "ticket-1" });
    const controller = new PmController(bridge, store);
    expect(await controller.addNote("ticket-1", { kind: "fact", text: "CSV too", url: null })).toBe(true);
    expect(bridge.calls[0]).toEqual({ method: "pm_ticket_note_add", params: { ticketId: "ticket-1", kind: "fact", text: "CSV too" } });
    expect(store.getState().notes["ticket-1"]).toEqual([note]);
    expect(bridge.calls.find((call) => call.method === "pm_agent_launch")?.params).toEqual({ projectId: "project-1", focusTicketId: "ticket-1", task: "updateDescription" });
    // The update runs in the background: the ticket stays in the stage.
    expect(store.getState().view).toBe("ticket");
    expect(bridge.calls.map((call) => call.method)).not.toContain("pm_agent_stop");

    // A second note goes to the same conversation; nothing is stopped.
    await controller.addNote("ticket-1", { kind: "fact", text: "PDF too", url: null });
    expect(bridge.calls.map((call) => call.method)).not.toContain("pm_agent_stop");
    expect(store.getState()).toMatchObject({ activeAgentSessionId: "agent-1", assistantResumable: true });

    await controller.updateDescription("ticket-1");
    expect(store.getState()).toMatchObject({ view: "agent", activeAgentSessionId: "agent-1" });
    const methods = bridge.calls.map((call) => call.method);
    expect(methods).not.toContain("pm_ticket_description_save");
    expect(methods).not.toContain("pm_ticket_update");
  });
});
