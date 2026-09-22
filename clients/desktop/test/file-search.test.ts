import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDirectoryResult, WorkspaceFileEntryDto } from "@termloop/contract/current";
import { FileSearch } from "../src/renderer/file-search.js";

const entry = (path: string, kind: WorkspaceFileEntryDto["kind"] = "file"): WorkspaceFileEntryDto => ({ name: path.split("/").at(-1)!, path, kind });
const directory = (path: string, entries: WorkspaceFileEntryDto[] = [], truncated = false): WorkspaceDirectoryResult => ({ path, entries, truncated });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; };
const finishDebounce = () => vi.advanceTimersByTimeAsync(180);

describe("File name search", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("finds hidden and nested files without expanding folders, with case-insensitive path matching", async () => {
    const folders: Record<string, WorkspaceDirectoryResult> = {
      "": directory("", [entry("src", "directory"), entry(".env"), entry("outside-link", "symlink")]),
      src: directory("src", [entry("src/nested", "directory")]),
      "src/nested": directory("src/nested", [entry("src/nested/App.ts")]),
    };
    const list = vi.fn(async (path: string) => folders[path]!);
    const search = new FileSearch(list);
    search.start();
    expect(list).not.toHaveBeenCalled();
    search.setQuery("NESTED app");
    await finishDebounce();
    expect(search.getSnapshot()).toMatchObject({ status: "ready", total: 1, entries: [entry("src/nested/App.ts")] });
    expect(list.mock.calls).toEqual([[""], ["src"], ["src/nested"]]);
    search.setQuery(" SRC\\NESTED ");
    expect(search.getSnapshot().total).toBe(1);
    search.setQuery(".ENV");
    expect(search.getSnapshot().entries).toEqual([entry(".env")]);
    search.setQuery("missing");
    expect(search.getSnapshot().total).toBe(0);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("uses the latest query during a scan without launching another crawl", async () => {
    const pending = deferred<WorkspaceDirectoryResult>();
    const list = vi.fn(() => pending.promise);
    const search = new FileSearch(list);
    search.start(); search.setQuery("old"); await finishDebounce();
    search.setQuery("new");
    pending.resolve(directory("", [entry("old.ts"), entry("new.ts")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledOnce();
    expect(search.getSnapshot().entries).toEqual([entry("new.ts")]);
  });

  it("reuses a completed index immediately after clearing the search", async () => {
    const list = vi.fn(async () => directory("", [entry("old.ts"), entry("new.ts")]));
    const search = new FileSearch(list);
    search.start(); search.setQuery("old"); await finishDebounce();
    search.setQuery("");
    expect(search.getSnapshot()).toMatchObject({ total: 0, entries: [] });
    search.setQuery("new");
    expect(search.getSnapshot()).toMatchObject({ status: "ready", entries: [entry("new.ts")] });
    await finishDebounce();
    expect(list).toHaveBeenCalledOnce();
  });

  it("finishes indexing while the input is empty without showing every file", async () => {
    const pending = deferred<WorkspaceDirectoryResult>();
    const list = vi.fn().mockResolvedValueOnce(directory("", [entry("src", "directory"), entry("first.ts")]))
      .mockReturnValueOnce(pending.promise);
    const search = new FileSearch(list);
    search.start(); search.setQuery("first"); await finishDebounce();
    search.setQuery("   ");
    pending.resolve(directory("src", [entry("src/next.ts")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot()).toMatchObject({ status: "ready", total: 0, entries: [] });
    search.setQuery("next");
    expect(search.getSnapshot().entries).toEqual([entry("src/next.ts")]);
    expect(list.mock.calls).toEqual([[""], ["src"]]);
  });

  it("cancels on refresh or disposal and rejects old root responses", async () => {
    const old = deferred<WorkspaceDirectoryResult>();
    const next = deferred<WorkspaceDirectoryResult>();
    const list = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const search = new FileSearch(list);
    search.start(); search.setQuery("file"); await finishDebounce();
    search.refresh();
    old.resolve(directory("", [entry("dir", "directory"), entry("file-old")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledOnce();
    expect(search.getSnapshot()).toMatchObject({ status: "searching", total: 0, entries: [] });
    await finishDebounce();
    search.dispose();
    const before = search.getSnapshot();
    next.resolve(directory("", [entry("file-late")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot()).toBe(before);
  });

  it("refreshes the filename index and preserves the query", async () => {
    const list = vi.fn().mockResolvedValueOnce(directory("", [entry("old.ts")])).mockResolvedValue(directory("", [entry("new.ts")]));
    const search = new FileSearch(list);
    search.start(); search.setQuery(".ts"); await finishDebounce();
    search.refresh(); await finishDebounce();
    expect(search.getSnapshot()).toMatchObject({ query: ".ts", entries: [entry("new.ts")] });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("reports unreadable or truncated folders while retaining other results", async () => {
    const list = vi.fn(async (path: string) => {
      if (path === "blocked") throw new Error("Permission denied");
      return directory("", [entry("blocked", "directory"), entry("file.ts")], true);
    });
    const search = new FileSearch(list);
    search.start(); search.setQuery("file"); await finishDebounce();
    expect(search.getSnapshot()).toMatchObject({ status: "ready", total: 1, unreadable: true, incomplete: true });
  });

  it("keeps scanning past 400 directories, 20,000 entries and cache exhaustion", async () => {
    const folders = Array.from({ length: 405 }, (_, i) => entry(`dir-${i}`, "directory"));
    const list = vi.fn(async (path: string) => path === "" ? directory("", folders)
      : directory(path, Array.from({ length: 55 }, (_, i) => entry(`${path}/Subscription-${i}.cs`))));
    const search = new FileSearch(list, { cacheBytes: 1 });
    search.start(); search.setQuery("subscription"); await finishDebounce();
    expect(list).toHaveBeenCalledTimes(406);
    expect(search.getSnapshot()).toMatchObject({ status: "ready", total: 405 * 55, incomplete: false });
    search.setQuery("dir-404/subscription-54"); await finishDebounce();
    expect(search.getSnapshot()).toMatchObject({ total: 1, entries: [entry("dir-404/Subscription-54.cs")] });
  });

  it("follows every directory page and finds children beyond the first page", async () => {
    const list = vi.fn(async (path: string, afterName?: string): Promise<WorkspaceDirectoryResult> => {
      if (path) return directory(path, [entry(`${path}/Subscription.cs`)]);
      return afterName ? directory("", [entry("z-folder", "directory")])
        : { ...directory("", [entry("a.ts")], true), next_name: "a.ts" };
    });
    const search = new FileSearch(list);
    search.start(); search.setQuery("subscription"); await finishDebounce();
    expect(list.mock.calls).toEqual([[""], ["", "a.ts"], ["z-folder"]]);
    expect(search.getSnapshot()).toMatchObject({ total: 1, incomplete: false });
  });

  it("continues after slow folders instead of imposing a deadline on the whole project", async () => {
    const list = vi.fn(async (path: string) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return path ? directory(path, [entry(`${path}/Subscription.cs`)]) : directory("", [entry("a", "directory"), entry("b", "directory")]);
    });
    const search = new FileSearch(list, { milliseconds: 50 });
    search.start(); search.setQuery("subscription"); await finishDebounce();
    await vi.advanceTimersByTimeAsync(100);
    expect(search.getSnapshot()).toMatchObject({ status: "ready", total: 2, unreadable: false, incomplete: false });
  });

  it("pipelines directory reads within a fixed bound and keeps moving past a slow sibling", async () => {
    const blocked = deferred<WorkspaceDirectoryResult>();
    let active = 0;
    let maximum = 0;
    const list = vi.fn(async (path: string) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (!path) return directory("", [entry("blocked", "directory"), ...Array.from({ length: 20 }, (_, i) => entry(`dir-${i}`, "directory"))]);
        if (path === "blocked") return await blocked.promise;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return directory(path, [entry(`${path}/file.ts`)]);
      } finally { active--; }
    });
    const search = new FileSearch(list);
    search.start(); search.setQuery("file"); await finishDebounce();
    await vi.advanceTimersByTimeAsync(210);
    expect(maximum).toBe(2);
    expect(list).toHaveBeenCalledTimes(22);
    expect(search.getSnapshot()).toMatchObject({ status: "searching", total: 20, unreadable: false });
    search.setQuery("dir-19");
    blocked.resolve(directory("blocked", [entry("blocked/file.ts")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot()).toMatchObject({ status: "ready", total: 1, entries: [entry("dir-19/file.ts")] });
  });

  it("still scans ignored dependency and build directories", async () => {
    const folders = ["node_modules", "bin", "obj", ".hidden"];
    const list = vi.fn(async (path: string) => path ? directory(path, [entry(`${path}/file.ts`)])
      : directory("", folders.map((name) => entry(name, "directory"))));
    const search = new FileSearch(list);
    search.start(); search.setQuery("file"); await finishDebounce();
    expect(search.getSnapshot()).toMatchObject({ status: "ready", total: 4, incomplete: false });
    expect(search.getSnapshot().entries.map((file) => file.path).sort()).toEqual(folders.map((folder) => `${folder}/file.ts`).sort());
  });

  it("discards both in-flight directory reads and queued children after refresh", async () => {
    const first = deferred<WorkspaceDirectoryResult>();
    const second = deferred<WorkspaceDirectoryResult>();
    const list = vi.fn().mockResolvedValueOnce(directory("", [entry("a", "directory"), entry("b", "directory"), entry("queued", "directory")]))
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      .mockResolvedValue(directory("", [entry("fresh.ts")]));
    const search = new FileSearch(list);
    search.start(); search.setQuery(".ts"); await finishDebounce();
    expect(list.mock.calls).toEqual([[""], ["a"], ["b"]]);
    search.refresh(); await finishDebounce();
    first.resolve(directory("a", [entry("a/late.ts"), entry("a/child", "directory")]));
    second.resolve(directory("b", [entry("b/late.ts")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(list.mock.calls).toEqual([[""], ["a"], ["b"], [""]]);
    expect(search.getSnapshot()).toMatchObject({ status: "ready", total: 1, entries: [entry("fresh.ts")] });
  });

  it("caps rendered results without losing the total count", async () => {
    const search = new FileSearch(async () => directory("", [entry("file-a"), entry("file-b")]), { results: 1 });
    search.start(); search.setQuery("file"); await finishDebounce();
    expect(search.getSnapshot()).toMatchObject({ total: 2, entries: [entry("file-a")], incomplete: false, pages: 2 });
    search.setPage(1);
    expect(search.getSnapshot().entries).toEqual([entry("file-b")]);
    search.setPage(0);
    expect(search.getSnapshot().entries).toEqual([entry("file-a")]);
  });

  it("ends a stalled directory read without publishing late results", async () => {
    const pending = deferred<WorkspaceDirectoryResult>();
    const search = new FileSearch(() => pending.promise, { milliseconds: 50 });
    search.start(); search.setQuery("file"); await finishDebounce();
    await vi.advanceTimersByTimeAsync(50);
    expect(search.getSnapshot()).toMatchObject({ status: "ready", unreadable: true });
    pending.resolve(directory("", [entry("file-late")]));
    await vi.advanceTimersByTimeAsync(0);
    expect(search.getSnapshot().entries).toEqual([]);
  });
});
