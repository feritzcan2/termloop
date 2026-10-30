import path from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeFilePath, worktreeRelativeFile } from "../src/main/worktree-open.js";
import { readWorktreeFiles, rememberWorktreeFile } from "../src/renderer/worktree-file-memory.js";

function fakeStorage(): Pick<Storage, "getItem" | "setItem"> {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key, next) => { value = next; } };
}

describe("worktree file open paths", () => {
  const worktree = path.resolve("/work/tree");

  it("keeps a picked file relative to its worktree", () => {
    expect(worktreeRelativeFile(worktree, path.join(worktree, "src", "App.sln"))).toBe("src/App.sln");
    expect(worktreeRelativeFile(worktree, path.resolve("/work/other/App.sln"))).toBeUndefined();
    expect(worktreeRelativeFile(worktree, worktree)).toBeUndefined();
  });

  it("resolves remembered paths only inside the worktree", () => {
    expect(worktreeFilePath(worktree, "src/App.sln")).toBe(path.join(worktree, "src", "App.sln"));
    for (const denied of ["../escape.sln", "src/../../escape", "/etc/passwd", "", 42]) {
      expect(() => worktreeFilePath(worktree, denied)).toThrow("worktreeFileDenied");
    }
  });
});

describe("worktree file memory", () => {
  it("keeps the most recent files first per Project, capped", () => {
    const storage = fakeStorage();
    rememberWorktreeFile("p1", "a.sln", storage);
    rememberWorktreeFile("p1", "b.sln", storage);
    rememberWorktreeFile("p1", "c.sln", storage);
    rememberWorktreeFile("p1", "a.sln", storage);
    rememberWorktreeFile("p1", "d.sln", storage);
    rememberWorktreeFile("p2", "x.sln", storage);
    expect(readWorktreeFiles("p1", storage)).toEqual(["d.sln", "a.sln", "c.sln"]);
    expect(readWorktreeFiles("p2", storage)).toEqual(["x.sln"]);
    expect(readWorktreeFiles(undefined, storage)).toEqual([]);
  });
});
