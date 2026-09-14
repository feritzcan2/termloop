import assert from "node:assert/strict";
import test from "node:test";
import { METHODS, READ_ONLY_METHODS, COMPANION_METHODS, validateMethodResult, MCP_IMPROVER_TOOLS } from "../dist/current.js";

test("creator has strict additive full-control-only methods and no execution tools", () => {
  for (const method of ["workflow.creatorPreview", "workflow.creatorLaunch", "workflow.creatorDraftGet"]) {
    assert.ok(METHODS.includes(method)); assert.ok(!READ_ONLY_METHODS.includes(method)); assert.ok(!COMPANION_METHODS.includes(method));
  }
  assert.ok(MCP_IMPROVER_TOOLS.includes("configuration_version_write"));
  assert.ok(!MCP_IMPROVER_TOOLS.includes("workflow_delegate"));
  assert.ok(!MCP_IMPROVER_TOOLS.includes("workflow_step_complete"));
});

test("proposal reads are typed and null is distinct from a malformed proposal", () => {
  assert.ok(validateMethodResult("workflow.creatorDraftGet", { versionId: null, proposal: null, summary: "" }));
  assert.ok(!validateMethodResult("workflow.creatorDraftGet", { versionId: null, summary: "" }));
  assert.ok(!validateMethodResult("workflow.creatorDraftGet", { versionId: "v", proposal: { workflow: {} }, summary: "" }));
});
