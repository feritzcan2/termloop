import { describe, expect, it } from "vitest";
import { readWorktreeBaseRef, writeWorktreeBaseRef } from "../src/renderer/worktree-base-ref-memory.js";

function fakeStorage(initial?: string): Pick<Storage, "getItem" | "setItem"> & { value: string | null } {
  const store = { value: initial ?? null } as { value: string | null };
  return {
    get value() { return store.value; },
    getItem: () => store.value,
    setItem: (_key: string, next: string) => { store.value = next; },
  };
}

describe("worktree base ref memory", () => {
  it("remembers the last base ref per Project across reads", () => {
    const storage = fakeStorage();
    writeWorktreeBaseRef("project-1", "refs/heads/develop", storage);
    writeWorktreeBaseRef("project-2", "refs/heads/main", storage);
    expect(readWorktreeBaseRef("project-1", storage)).toBe("refs/heads/develop");
    expect(readWorktreeBaseRef("project-2", storage)).toBe("refs/heads/main");
  });

  it("ignores a missing Project id and blank refs", () => {
    const storage = fakeStorage();
    writeWorktreeBaseRef(undefined, "refs/heads/main", storage);
    writeWorktreeBaseRef("project-1", "   ", storage);
    expect(storage.value).toBeNull();
    expect(readWorktreeBaseRef(undefined, storage)).toBeUndefined();
  });

  it("survives corrupt or foreign stored values", () => {
    expect(readWorktreeBaseRef("project-1", fakeStorage("not json"))).toBeUndefined();
    expect(readWorktreeBaseRef("project-1", fakeStorage("[1,2]"))).toBeUndefined();
    expect(readWorktreeBaseRef("project-1", fakeStorage('{"project-1": 42}'))).toBeUndefined();
  });

  it("caps stored Projects by recency, dropping the longest untouched first", () => {
    const storage = fakeStorage();
    for (let index = 0; index < 33; index += 1) {
      writeWorktreeBaseRef(`project-${index}`, `refs/heads/branch-${index}`, storage);
    }
    writeWorktreeBaseRef("project-1", "refs/heads/refreshed", storage);
    expect(readWorktreeBaseRef("project-0", storage)).toBeUndefined();
    expect(readWorktreeBaseRef("project-1", storage)).toBe("refs/heads/refreshed");
    expect(readWorktreeBaseRef("project-32", storage)).toBe("refs/heads/branch-32");
  });
});
