import { describe, expect, it } from "vitest";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { fakeBridge, jiraDiff, ok } from "./fixtures.js";

describe("PmController", () => {
  it("accepts an agent proposal only through pm_ticket_proposal_accept", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_ticket_proposals_read") return ok({ proposals: [] });
      if (method === "pm_board_read") return ok({ projectId: "project-1", sprints: [], tickets: [], environments: [], probes: [], runningChecks: [], tracking: { jira: false, code: false, deploy: false, tier: "tickets" } });
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

  it("stores a typed Jira token in the credential store and sends only its handle with the sources", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_credential_store") return ok({ credentialHandle: "handle-1" });
      if (method === "pm_sources_set") return ok({ projectId: "project-1", jira: null, github: null, azureDevOps: null });
      if (method === "pm_board_read") return { ok: false, error: { code: "unavailable", message: "offline" } };
      return ok({});
    });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    await controller.saveSources({ siteUrl: "https://acme.atlassian.net", boardId: 3, accountEmail: "pm@acme.test", token: "s3cret" }, null);
    expect(bridge.calls[0]).toEqual({ method: "pm_credential_store", params: { kind: "jiraApiToken", secret: "s3cret" } });
    const sourcesCall = bridge.calls.find((call) => call.method === "pm_sources_set");
    expect(JSON.stringify(sourcesCall?.params)).not.toContain("s3cret");
    expect(sourcesCall?.params).toMatchObject({ jira: { credentialHandle: "handle-1" }, github: null, azureDevOps: null });
  });

  it("sends an Azure DevOps code host in place of a GitHub one", async () => {
    const bridge = fakeBridge((method) => method === "pm_sources_set"
      ? ok({ projectId: "project-1", jira: null, github: null, azureDevOps: null })
      : { ok: false, error: { code: "unavailable", message: "offline" } });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    await controller.saveSources(null, { kind: "azureDevOps", organization: "contoso", project: "Parking", name: "Nucleus" });
    expect(bridge.calls.find((call) => call.method === "pm_sources_set")?.params).toEqual({
      projectId: "project-1", jira: null, github: null, azureDevOps: { organization: "contoso", project: "Parking", name: "Nucleus" },
    });
  });

  it("rereads the digest with every board reread, so board changes reach Since yesterday", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_board_read") return ok({ projectId: "project-1", sprints: [], tickets: [], environments: [], probes: [], runningChecks: [], tracking: { jira: false, code: false, deploy: false, tier: "tickets" } });
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

  it("loads the agent catalog with the settings", async () => {
    const catalog = { providers: [{ id: "claude", label: "Claude", models: ["default"], permissions: { assistant: ["default"], check: ["bypassPermissions"] } }] };
    const bridge = fakeBridge((method) => method === "pm_agent_catalog_read" ? ok(catalog) : ok({}));
    const store = createPmStore({ projectId: "project-1" });
    await new PmController(bridge, store).loadSettings();
    expect(store.getState().catalog).toEqual(catalog);
  });
  it("records a note and starts a background description update without changing the ticket", async () => {
    const note = { id: "note-1", ticketId: "ticket-1", kind: "fact", text: "CSV too", url: null, sourceKey: null, author: "pm", createdAtEpochMs: 1, pending: true };
    const session = (sessionId: string) => ({ sessionId, projectId: "project-1", mode: "assistant", provider: "claude", focusTicketId: "ticket-1", checkId: null, skillId: null, state: "running", startedAtEpochMs: 0, exitedAtEpochMs: null });
    let launched = 0;
    const live: ReturnType<typeof session>[] = [];
    const bridge = fakeBridge((method) => {
      if (method === "pm_ticket_note_add") return ok(note);
      if (method === "pm_ticket_notes_read") return ok({ ticketId: "ticket-1", notes: [note] });
      if (method === "pm_agent_launch") {
        live.push(session(`agent-${++launched}`));
        return ok(live.at(-1));
      }
      if (method === "pm_agent_list") return ok({ sessions: live });
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

    // A second note replaces the first update, so one draft merges both.
    await controller.addNote("ticket-1", { kind: "fact", text: "PDF too", url: null });
    expect(bridge.calls.filter((call) => call.method === "pm_agent_stop").map((call) => call.params)).toEqual([{ sessionId: "agent-1" }]);
    expect(store.getState().activeAgentSessionId).toBe("agent-2");

    await controller.updateDescription("ticket-1");
    expect(store.getState()).toMatchObject({ view: "agent", activeAgentSessionId: "agent-3" });
    const methods = bridge.calls.map((call) => call.method);
    expect(methods).not.toContain("pm_ticket_description_save");
    expect(methods).not.toContain("pm_ticket_update");
  });
});
