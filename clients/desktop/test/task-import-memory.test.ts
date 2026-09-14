import { describe, expect, it } from "vitest";
import type { TaskImportChoice } from "../src/renderer/project-task-automation.js";
import { readTaskImportChoice, rememberTaskImportChoice } from "../src/renderer/task-import-memory.js";

const choice: TaskImportChoice = {
  createWorktree: true,
  worktreePrefix: "feature",
  baseRef: "refs/remotes/origin/development",
  agentId: "codex",
  workflowId: null,
  model: "gpt-6-astra",
  permission: "plan",
  reasoning: "xhigh",
  kickoffMessage: "Implement and verify this Task.",
};

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
}

describe("Task import choice memory", () => {
  it("keeps the latest choice separately for each connection-qualified Project", () => {
    const storage = memoryStorage();
    rememberTaskImportChoice("local:project-1", choice, storage);
    rememberTaskImportChoice("remote:project-1", { ...choice, worktreePrefix: "fix" }, storage);
    rememberTaskImportChoice("local:project-1", { ...choice, model: "default" }, storage);
    expect(readTaskImportChoice("local:project-1", storage)).toEqual({ ...choice, model: "default" });
    expect(readTaskImportChoice("remote:project-1", storage)).toEqual({ ...choice, worktreePrefix: "fix" });
    expect(readTaskImportChoice("other", storage)).toBeUndefined();
  });

  it("falls back for malformed data and invalid enums without losing valid Projects", () => {
    for (const value of ["invalid JSON", "null", "[]", JSON.stringify({ p: { ...choice, permission: "unknown" } }), JSON.stringify({ p: { ...choice, baseRef: 7 } })]) {
      expect(readTaskImportChoice("p", memoryStorage(value))).toBeUndefined();
    }
    const storage = memoryStorage(JSON.stringify({ valid: choice, invalid: { ...choice, reasoning: "unknown" } }));
    expect(readTaskImportChoice("valid", storage)).toEqual(choice);
    expect(readTaskImportChoice("invalid", storage)).toBeUndefined();
  });

  it("keeps bounded form drafts so an incomplete edit can be corrected after reopening", () => {
    const storage = memoryStorage();
    const draft = { ...choice, worktreePrefix: "", kickoffMessage: "" };
    rememberTaskImportChoice("p", draft, storage);
    expect(readTaskImportChoice("p", storage)).toEqual(draft);
  });

  it("bounds memory to the 32 most recently edited Projects", () => {
    const storage = memoryStorage();
    for (let i = 0; i < 32; i += 1) rememberTaskImportChoice(`p-${i}`, choice, storage);
    rememberTaskImportChoice("p-0", choice, storage);
    rememberTaskImportChoice("p-32", choice, storage);
    expect(readTaskImportChoice("p-0", storage)).toEqual(choice);
    expect(readTaskImportChoice("p-1", storage)).toBeUndefined();
    expect(readTaskImportChoice("p-32", storage)).toEqual(choice);
  });

  it("does not interrupt the form when storage is unavailable or full", () => {
    const unavailable = { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("full"); } };
    expect(readTaskImportChoice("p", unavailable)).toBeUndefined();
    expect(() => rememberTaskImportChoice("p", choice, unavailable)).not.toThrow();
    expect(() => rememberTaskImportChoice("p", choice, { ...unavailable, getItem: () => null })).not.toThrow();
  });
});
