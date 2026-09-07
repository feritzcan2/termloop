import assert from "node:assert/strict";
import test from "node:test";
import { METHODS, READ_ONLY_METHODS, COMPANION_METHODS, validateMethodResult } from "../dist/current.js";

test("agent library uses strict full-control commands and bounded personal profiles", () => {
  for (const method of ["agent.libraryGet", "agent.profileCreate", "agent.profileUpdate", "agent.profileDelete", "agent.profileFavorite"]) {
    assert.ok(METHODS.includes(method));
    assert.ok(!READ_ONLY_METHODS.includes(method));
    assert.ok(!COMPANION_METHODS.includes(method));
  }
  const profile = {
    id: "custom.agent-profile.reviewer", version: 1, name: "Reviewer", description: "Review changes", category: "Quality",
    instructions: "Inspect this", permission: "plan", read_only: true, user_invocable: true, agent_ids: ["claude", "codex"],
    source: "personal", favorite: false, default_agent_id: "codex", default_model: "default", default_reasoning: "high",
  };
  assert.ok(validateMethodResult("agent.libraryGet", { revision: 1, profiles: [profile] }));
  assert.ok(!validateMethodResult("agent.libraryGet", { revision: 1, profiles: [{ ...profile, secret: "private" }] }));
  assert.ok(!validateMethodResult("agent.libraryGet", { revision: 1, profiles: [{ ...profile, instructions: "x".repeat(32769) }] }));
  assert.ok(!validateMethodResult("agent.libraryGet", { revision: 1, profiles: Array(65).fill(profile) }));
});
