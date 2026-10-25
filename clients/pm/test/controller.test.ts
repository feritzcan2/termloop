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
      if (method === "pm_sources_set") return ok({ projectId: "project-1", jira: null, github: null });
      if (method === "pm_board_read") return { ok: false, error: { code: "unavailable", message: "offline" } };
      return ok({});
    });
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    await controller.saveSources({ siteUrl: "https://acme.atlassian.net", boardId: 3, accountEmail: "pm@acme.test", token: "s3cret" }, null);
    expect(bridge.calls[0]).toEqual({ method: "pm_credential_store", params: { kind: "jiraApiToken", secret: "s3cret" } });
    const sourcesCall = bridge.calls.find((call) => call.method === "pm_sources_set");
    expect(JSON.stringify(sourcesCall?.params)).not.toContain("s3cret");
    expect(sourcesCall?.params).toMatchObject({ jira: { credentialHandle: "handle-1" } });
  });
});
