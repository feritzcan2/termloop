import assert from "node:assert/strict";
import test from "node:test";
import { READ_ONLY_METHODS, COMPANION_METHODS, validateMethodResult } from "../dist/current.js";

test("workspace files are bounded full-control observations", () => {
  for (const method of ["workspace.directoryList", "workspace.fileRead"]) {
    assert.equal(READ_ONLY_METHODS.includes(method), false);
    assert.equal(COMPANION_METHODS.includes(method), false);
  }
  assert.equal(validateMethodResult("workspace.fileRead", { path: "f", state: "text", content: "a".repeat(262144) }), true);
  assert.equal(validateMethodResult("workspace.fileRead", { path: "f", state: "text", content: "ü".repeat(131073) }), false);
  assert.equal(validateMethodResult("workspace.directoryList", { path: "", entries: [], truncated: true, next_name: "last.cs", omitted: false }), true);
  assert.equal(validateMethodResult("workspace.directoryList", { path: "", entries: [], truncated: true, next_name: "" }), false);
});
