import assert from "node:assert/strict";
import test from "node:test";
import { READ_ONLY_METHODS, COMPANION_METHODS, validateMethodResult } from "../dist/current.js";

test("workspace files are bounded full-control observations", () => {
  for (const method of ["workspace.directoryList", "workspace.fileRead", "workspace.fileSearch", "workspace.fileWrite"]) {
    assert.equal(READ_ONLY_METHODS.includes(method), false);
    assert.equal(COMPANION_METHODS.includes(method), false);
  }
  assert.equal(validateMethodResult("workspace.fileRead", { path: "f", state: "text", content: "a".repeat(262144) }), true);
  assert.equal(validateMethodResult("workspace.fileRead", { path: "f", state: "text", content: "ü".repeat(131073) }), false);
  assert.equal(validateMethodResult("workspace.directoryList", { path: "", entries: [], truncated: true, next_name: "last.cs", omitted: false }), true);
  assert.equal(validateMethodResult("workspace.directoryList", { path: "", entries: [], truncated: true, next_name: "" }), false);
  const entry = { name: "a", path: "a", kind: "file" };
  assert.equal(validateMethodResult("workspace.fileSearch", { query: "a", entries: [entry], total: 9, incomplete: false, unreadable: false }), true);
  assert.equal(validateMethodResult("workspace.fileSearch", { query: "a", entries: Array(201).fill(entry), total: 201, incomplete: false, unreadable: false }), false);
});

test("workspace file writes report the new or conflicting version", () => {
  const version = "0".repeat(64);
  assert.equal(validateMethodResult("workspace.fileWrite", { path: "a.ts", state: "written", version }), true);
  assert.equal(validateMethodResult("workspace.fileWrite", { path: "a.ts", state: "saved", version }), false);
  assert.equal(validateMethodResult("workspace.fileWrite", { path: "a.ts", state: "conflict", version: null }), true);
  assert.equal(validateMethodResult("workspace.fileRead", { path: "a.ts", state: "text", content: "x", version }), true);
});
