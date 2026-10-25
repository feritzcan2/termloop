import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITY_SCOPE, CONTRACT_IDENTITY, EVENTS, METHODS, TermLoopPmClient, TermLoopPmError, pmRequestTimeoutMs, validateEventPayload, validateMethodResult } from "../dist/pm.js";

test("generated PM contract surface is stable", () => {
  assert.match(CONTRACT_IDENTITY, /^sha256:[0-9a-f]{64}$/);
  assert.equal(CAPABILITY_SCOPE, "pm.full");
  assert.deepEqual(METHODS, ["pm_system_version","pm_subscribe","pm_cancel","pm_project_list","pm_project_create","pm_board_read","pm_digest_read","pm_sprint_create","pm_sprint_update","pm_sprint_activate","pm_sprint_close","pm_ticket_create","pm_ticket_update","pm_ticket_move","pm_ticket_description_save","pm_ticket_versions_read","pm_ticket_blocker_add","pm_ticket_blocker_remove","pm_ticket_criterion_add","pm_ticket_criterion_set_done","pm_ticket_criterion_remove","pm_ticket_proposals_read","pm_ticket_proposal_accept","pm_ticket_proposal_reject","pm_environments_set","pm_sources_read","pm_sources_set","pm_credential_store","pm_credential_clear","pm_probe_create","pm_probe_approve","pm_probe_reject","pm_probe_delete","pm_check_start","pm_checks_read","pm_jira_pull","pm_jira_diff_read","pm_jira_apply","pm_agent_launch","pm_agent_list","pm_agent_stop","pm_agent_catalog_read","pm_settings_read","pm_settings_update"]);
  assert.deepEqual(EVENTS, ["pmBoardChanged","pmAgentChanged","pmCheckChanged","pmJiraPulled"]);
  assert.equal(pmRequestTimeoutMs("pm_jira_apply"), 300_000);
  assert.equal(pmRequestTimeoutMs("pm_board_read"), 12_000);
});

test("PM results reject secrets and unknown fields", () => {
  assert.equal(validateMethodResult("pm_credential_store", { credentialHandle: "jira-acme" }), true);
  assert.equal(validateMethodResult("pm_credential_store", { credentialHandle: "jira-acme", secret: "x" }), false);
  const sources = { projectId: "p1", github: { owner: "acme", name: "pay.api" }, jira: { siteUrl: "https://acme.atlassian.net", boardId: null, accountEmail: "ada@acme.example", credentialHandle: "jira-acme" } };
  assert.equal(validateMethodResult("pm_sources_read", sources), true);
  assert.equal(validateMethodResult("pm_sources_read", { ...sources, jira: { ...sources.jira, siteUrl: "https://acme.atlassian.net/?token=x" } }), false);
  assert.equal(validateEventPayload("pmBoardChanged", { projectId: "p1" }), true);
  assert.equal(validateEventPayload("pmBoardChanged", { projectId: "" }), false);
});

test("PM client sends the PM identity and maps typed errors", async () => {
  const sent = [];
  let listener;
  const socket = {
    addEventListener(type, handler) { if (type === "open") queueMicrotask(handler); if (type === "message") listener = handler; },
    send(data) { sent.push(JSON.parse(data)); },
    close() {},
  };
  const client = new TermLoopPmClient("ws://127.0.0.1:1/control", "t".repeat(64), () => socket);
  const pending = client.call("pm_board_read", { projectId: "p1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent[0].protocolVersion, CONTRACT_IDENTITY);
  assert.equal(sent[0].method, "pm_board_read");
  listener({ data: JSON.stringify({ id: sent[0].id, ok: false, error: { code: "invalidParams", message: "invalid projectId", details: { kind: "invalidParameter", parameter: "projectId" } } }) });
  await assert.rejects(pending, (error) => error instanceof TermLoopPmError && error.code === "invalidParams" && error.details.parameter === "projectId");
  client.close();
});
