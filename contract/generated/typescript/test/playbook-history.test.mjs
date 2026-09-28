import assert from "node:assert/strict";
import test from "node:test";
import { METHODS, READ_ONLY_METHODS, COMPANION_METHODS, validateMethodResult } from "../dist/current.js";

test("Playbook fork history is bounded, strict and full-control only", () => {
  const method = "playbook.evaluationHistory";
  assert.ok(METHODS.includes(method));
  assert.ok(!READ_ONLY_METHODS.includes(method));
  assert.ok(!COMPANION_METHODS.includes(method));
  const entry = {
    id: "check", projectId: "project-a", taskId: "task-a", taskTitle: "Search fix",
    milestoneId: "verified", milestoneTitle: "Dev verified", sourceSessionId: "source",
    sourceName: "Implementer", sessionId: "fork", agentId: "codex", model: "gpt-6-luna",
    permission: "plan", startedAtEpochMs: 1, finishedAtEpochMs: 2, outcome: "passed", evidence: "Verified.",
  };
  const result = (entries) => ({ entries, retentionLimit: 200, stateRevision: 4 });
  assert.equal(validateMethodResult(method, result([entry])), true);
  assert.equal(validateMethodResult(method, result([])), true);
  assert.equal(validateMethodResult(method, result([{ ...entry, outcome: "unknown" }])), false);
  assert.equal(validateMethodResult(method, result([{ ...entry, evidence: "ş".repeat(301) }])), false);
  assert.equal(validateMethodResult(method, result([{ ...entry, nativeConversationId: "private" }])), false);
  assert.equal(validateMethodResult(method, result(Array(201).fill(entry))), false);
});
