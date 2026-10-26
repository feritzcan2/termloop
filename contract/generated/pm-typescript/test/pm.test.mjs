import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITY_SCOPE, CONTRACT_IDENTITY, EVENTS, METHODS, TermLoopPmClient, TermLoopPmError, pmRequestTimeoutMs, validateEventPayload, validateMethodResult } from "../dist/pm.js";

test("generated PM contract surface is stable", () => {
  assert.match(CONTRACT_IDENTITY, /^sha256:[0-9a-f]{64}$/);
  assert.equal(CAPABILITY_SCOPE, "pm.full");
  assert.deepEqual(METHODS, ["pm_system_version","pm_subscribe","pm_cancel","pm_project_list","pm_project_create","pm_project_update","pm_project_delete","pm_board_read","pm_digest_read","pm_sprint_create","pm_sprint_update","pm_sprint_activate","pm_sprint_close","pm_sprint_delete","pm_ticket_create","pm_ticket_update","pm_ticket_move","pm_ticket_description_save","pm_ticket_versions_read","pm_ticket_blocker_add","pm_ticket_blocker_remove","pm_ticket_criterion_add","pm_ticket_criterion_set_done","pm_ticket_criterion_remove","pm_ticket_proposals_read","pm_ticket_proposal_accept","pm_ticket_proposal_reject","pm_ticket_notes_read","pm_ticket_note_add","pm_ticket_note_remove","pm_sources_read","pm_sources_set","pm_credential_store","pm_credential_clear","pm_playbook_save","pm_playbook_proposal_apply","pm_playbook_proposal_discard","pm_playbook_step_mark","pm_check_start","pm_checks_read","pm_jira_pull","pm_jira_diff_read","pm_jira_apply","pm_jira_projects_read","pm_jira_statuses_read","pm_jira_favourite_filters_read","pm_jira_search","pm_agent_launch","pm_agent_list","pm_agent_stop","pm_agent_catalog_read","pm_settings_read","pm_settings_update","pm_skills_read","pm_tools_read","pm_skill_suggestions_read","pm_skill_set_enabled","pm_skill_update","pm_skill_install","pm_skill_run","pm_skill_creator_launch","pm_skill_feedback_read","pm_skill_draft_dry_run","pm_skill_draft_discard"]);
  assert.deepEqual(EVENTS, ["pmBoardChanged","pmAgentChanged","pmCheckChanged","pmJiraPulled","pmSkillsChanged"]);
  assert.equal(pmRequestTimeoutMs("pm_jira_apply"), 300_000);
  assert.equal(pmRequestTimeoutMs("pm_jira_search"), 300_000);
  assert.equal(pmRequestTimeoutMs("pm_board_read"), 12_000);
});

test("PM results reject secrets and unknown fields", () => {
  assert.equal(validateMethodResult("pm_credential_store", { credentialHandle: "jira-acme" }), true);
  assert.equal(validateMethodResult("pm_credential_store", { credentialHandle: "jira-acme", secret: "x" }), false);
  const sources = { projectId: "p1", github: { owner: "acme", name: "pay.api" }, azureDevOps: null, jira: { siteUrl: "https://acme.atlassian.net", boardId: null, accountEmail: "ada@acme.example", credentialHandle: "jira-acme" } };
  assert.equal(validateMethodResult("pm_sources_read", sources), true);
  assert.equal(validateMethodResult("pm_sources_read", { ...sources, jira: { ...sources.jira, siteUrl: "https://acme.atlassian.net/?token=x" } }), false);
  const azure = { ...sources, github: null, azureDevOps: { organization: "contoso", project: "Parking Platform", name: "Nucleus" } };
  assert.equal(validateMethodResult("pm_sources_read", azure), true);
  assert.equal(validateMethodResult("pm_sources_read", { ...azure, azureDevOps: { ...azure.azureDevOps, organization: "-contoso" } }), false);
  assert.equal(validateMethodResult("pm_sources_read", { ...azure, azureDevOps: { ...azure.azureDevOps, token: "x" } }), false);
  assert.equal(validateEventPayload("pmBoardChanged", { projectId: "p1" }), true);
  assert.equal(validateEventPayload("pmBoardChanged", { projectId: "" }), false);
});

test("Jira browse results validate issue rows", () => {
  const issue = { id: "10042", key: "PAY-42", url: "https://acme.atlassian.net/browse/PAY-42", title: "Checkout fails", issueType: null, status: { name: "In Progress", category: "indeterminate" }, priority: "High", assignee: { displayName: "Ada", avatarUrl: "https://avatars.example/a.png" }, reporter: null, labels: [], sprint: "Sprint 8", updatedAtEpochMs: 2, createdAtEpochMs: 1, pmTicketId: null };
  const result = { projectId: "p1", issues: [issue], truncated: false, jql: "statusCategory != Done ORDER BY updated DESC" };
  assert.equal(validateMethodResult("pm_jira_search", result), true);
  assert.equal(validateMethodResult("pm_jira_search", { ...result, issues: [{ ...issue, url: "https://acme.atlassian.net/browse/PAY-42?x=1" }] }), false);
  assert.equal(validateMethodResult("pm_jira_statuses_read", { projectId: "p1", statuses: [{ id: "1", name: "To Do", category: "new" }], columns: [] }), true);
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
