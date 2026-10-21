import { describe, expect, it, vi } from "vitest";
import type { WorkspaceFileReadResult, WorkspaceFileWriteResult } from "@termloop/contract/current";
import { FileEditor, type FileEditorIo } from "../src/renderer/file-editor.js";

const version = (digit: string) => digit.repeat(64);
const text = (path: string, content: string, digit = "1"): WorkspaceFileReadResult => ({ path, state: "text", content, version: version(digit) });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function editorWith(io: Partial<FileEditorIo>) {
  const read = vi.fn(io.read ?? (async (path: string) => text(path, `${path} contents`)));
  const write = vi.fn(io.write ?? (async (path: string): Promise<WorkspaceFileWriteResult> => ({ path, state: "written", version: version("2") })));
  return { editor: new FileEditor({ read, write }), read, write };
}

describe("File editor tabs", () => {
  it("opens each path once, tracks drafts and saves against the version it read", async () => {
    const { editor, read, write } = editorWith({});
    editor.open("a.ts"); editor.open("b.ts"); await settle();
    editor.open("a.ts"); await settle();
    expect(editor.getSnapshot().tabs.map((tab) => tab.path)).toEqual(["a.ts", "b.ts"]);
    expect(editor.getSnapshot().active).toBe("a.ts");
    // Activating a clean tab revalidates it against the disk.
    expect(read).toHaveBeenCalledTimes(3);
    editor.edit("a.ts", "changed");
    expect(editor.dirty()).toBe(true);
    await editor.save("a.ts");
    expect(write).toHaveBeenCalledWith("a.ts", "changed", version("1"));
    expect(editor.tab("a.ts")).toMatchObject({ saved: { content: "changed", version: version("2") }, saving: false });
    expect(editor.dirty()).toBe(false);
    await editor.save("a.ts");
    expect(write).toHaveBeenCalledOnce();
  });

  it("publishes only dirty-state flips while typing and stays dirty for edits made during a save", async () => {
    const pending = deferred<WorkspaceFileWriteResult>();
    const { editor } = editorWith({ write: () => pending.promise });
    editor.open("a.ts"); await settle();
    const listener = vi.fn();
    editor.subscribe(listener);
    editor.edit("a.ts", "a"); editor.edit("a.ts", "ab"); editor.edit("a.ts", "abc");
    expect(listener).toHaveBeenCalledOnce();
    const saving = editor.save("a.ts");
    editor.edit("a.ts", "abcd");
    pending.resolve({ path: "a.ts", state: "written", version: version("4") }); await saving;
    expect(editor.tab("a.ts")).toMatchObject({ dirty: true, saved: { content: "abc", version: version("4") } });
    editor.edit("a.ts", "abc");
    expect(editor.dirty()).toBe(false);
  });

  it("keeps the draft on a conflict and overwrites only the version the user saw", async () => {
    const write = vi.fn<FileEditorIo["write"]>()
      .mockResolvedValueOnce({ path: "a.ts", state: "conflict", version: version("9") })
      .mockResolvedValueOnce({ path: "a.ts", state: "written", version: version("3") });
    const { editor } = editorWith({ write });
    editor.open("a.ts"); await settle();
    editor.edit("a.ts", "mine");
    await editor.save("a.ts");
    expect(editor.tab("a.ts")).toMatchObject({ dirty: true, conflict: { version: version("9") } });
    expect(editor.draft("a.ts")).toBe("mine");
    await editor.save("a.ts", true);
    expect(write).toHaveBeenLastCalledWith("a.ts", "mine", version("9"));
    expect(editor.tab("a.ts")).toMatchObject({ conflict: undefined, saved: { content: "mine", version: version("3") } });
  });

  it("reloads a conflicting tab from disk and never overwrites an uncomparable file", async () => {
    const read = vi.fn<FileEditorIo["read"]>().mockResolvedValueOnce(text("a.ts", "old")).mockResolvedValueOnce(text("a.ts", "theirs", "5"));
    const write = vi.fn<FileEditorIo["write"]>().mockResolvedValue({ path: "a.ts", state: "conflict", version: null });
    const { editor } = editorWith({ read, write });
    editor.open("a.ts"); await settle();
    editor.edit("a.ts", "mine");
    await editor.save("a.ts");
    await editor.save("a.ts", true);
    expect(write).toHaveBeenCalledOnce();
    editor.reload("a.ts"); await settle();
    expect(editor.tab("a.ts")).toMatchObject({ dirty: false, conflict: undefined, saved: { version: version("5") } });
    expect(editor.draft("a.ts")).toBe("theirs");
  });

  it("never lets a quiet revalidation replace edits made while it was in flight", async () => {
    const pending = deferred<WorkspaceFileReadResult>();
    const read = vi.fn<FileEditorIo["read"]>().mockResolvedValueOnce(text("a.ts", "one")).mockResolvedValueOnce(text("b.ts", "two")).mockReturnValueOnce(pending.promise);
    const { editor } = editorWith({ read });
    editor.open("a.ts"); editor.open("b.ts"); await settle();
    editor.activate("a.ts");
    editor.edit("a.ts", "typing");
    pending.resolve(text("a.ts", "external", "7")); await settle();
    expect(editor.tab("a.ts")).toMatchObject({ dirty: true, saved: { content: "one" } });
    expect(editor.draft("a.ts")).toBe("typing");
  });

  it("explains unopenable files and drops late responses after close or dispose", async () => {
    const pending = deferred<WorkspaceFileReadResult>();
    const read = vi.fn<FileEditorIo["read"]>()
      .mockResolvedValueOnce({ path: "bin", state: "binary", content: null })
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("File removed"));
    const { editor } = editorWith({ read });
    editor.open("bin"); await settle();
    expect(editor.tab("bin")).toMatchObject({ status: "unavailable", message: expect.stringContaining("Binary") });
    editor.open("late"); editor.close("late");
    pending.resolve(text("late", "late")); await settle();
    expect(editor.tab("late")).toBeUndefined();
    expect(editor.getSnapshot().active).toBe("bin");
    editor.open("gone"); await settle();
    expect(editor.tab("gone")).toMatchObject({ status: "unavailable", message: "File removed" });
    const before = editor.getSnapshot();
    editor.dispose();
    editor.close("bin");
    expect(editor.getSnapshot()).toBe(before);
  });

  it("selects the neighbouring tab after closing the active one", async () => {
    const { editor } = editorWith({});
    for (const path of ["a", "b", "c"]) editor.open(path);
    await settle();
    editor.activate("b");
    editor.close("b");
    expect(editor.getSnapshot().active).toBe("c");
    editor.close("c");
    expect(editor.getSnapshot().active).toBe("a");
    editor.close("a");
    expect(editor.getSnapshot()).toEqual({ tabs: [], active: undefined });
  });
});
