import { describe, expect, it } from "vitest";
import { readWorktreeParentPath, writeWorktreeParentPath } from "../src/renderer/worktree-parent-memory.js";

function fakeStorage(initial?: string): Pick<Storage, "getItem" | "setItem"> & { value: string | null } {
  const store = { value: initial ?? null } as { value: string | null };
  return {
    get value() { return store.value; },
    getItem: () => store.value,
    setItem: (_key: string, next: string) => { store.value = next; },
  };
}

describe("worktree parent memory", () => {
  it("remembers the last parent per Project across reads", () => {
    const storage = fakeStorage();
    writeWorktreeParentPath("project-1", "/Users/ferit/worktrees", storage);
    writeWorktreeParentPath("project-2", "/Volumes/code", storage);
    expect(readWorktreeParentPath("project-1", storage)).toBe("/Users/ferit/worktrees");
    expect(readWorktreeParentPath("project-2", storage)).toBe("/Volumes/code");
  });

  it("ignores a missing Project id and blank paths", () => {
    const storage = fakeStorage();
    writeWorktreeParentPath(undefined, "/anywhere", storage);
    writeWorktreeParentPath("project-1", "   ", storage);
    expect(storage.value).toBeNull();
    expect(readWorktreeParentPath(undefined, storage)).toBeUndefined();
  });

  it("survives corrupt or foreign stored values", () => {
    expect(readWorktreeParentPath("project-1", fakeStorage("not json"))).toBeUndefined();
    expect(readWorktreeParentPath("project-1", fakeStorage("[1,2]"))).toBeUndefined();
    expect(readWorktreeParentPath("project-1", fakeStorage('{"project-1": 42}'))).toBeUndefined();
  });

  it("caps stored Projects by recency, dropping the longest untouched first", () => {
    const storage = fakeStorage();
    for (let index = 0; index < 33; index += 1) {
      writeWorktreeParentPath(`project-${index}`, `/parents/${index}`, storage);
    }
    writeWorktreeParentPath("project-1", "/parents/refreshed", storage);
    expect(readWorktreeParentPath("project-0", storage)).toBeUndefined();
    expect(readWorktreeParentPath("project-1", storage)).toBe("/parents/refreshed");
    expect(readWorktreeParentPath("project-32", storage)).toBe("/parents/32");
  });
});
