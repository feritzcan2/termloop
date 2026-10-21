import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileEntryDto, WorkspaceFileSearchResult } from "@termloop/contract/current";
import { FileSearch } from "../src/renderer/file-search.js";

const entry = (path: string): WorkspaceFileEntryDto => ({ name: path.split("/").at(-1)!, path, kind: "file" });
const found = (query: string, paths: string[], extra: Partial<WorkspaceFileSearchResult> = {}): WorkspaceFileSearchResult =>
  ({ query, entries: paths.map(entry), total: paths.length, incomplete: false, unreadable: false, ...extra });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; };
const finishDebounce = () => vi.advanceTimersByTimeAsync(120);

describe("File name search", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("sends one trimmed daemon search per settled query", async () => {
    const search = vi.fn(async (query: string) => found(query, ["src/nested/App.ts"]));
    const files = new FileSearch(search);
    files.start();
    files.setQuery("N"); files.setQuery("NE"); files.setQuery("  NESTED app ");
    expect(files.getSnapshot().status).toBe("searching");
    await finishDebounce();
    expect(search.mock.calls).toEqual([["NESTED app"]]);
    expect(files.getSnapshot()).toMatchObject({ status: "ready", total: 1, entries: [entry("src/nested/App.ts")] });
  });

  it("clears results for a blank query without calling the daemon", async () => {
    const search = vi.fn(async (query: string) => found(query, ["a.ts"]));
    const files = new FileSearch(search);
    files.start(); files.setQuery("a"); await finishDebounce();
    files.setQuery("   "); await finishDebounce();
    expect(search).toHaveBeenCalledOnce();
    expect(files.getSnapshot()).toMatchObject({ status: "idle", total: 0, entries: [] });
  });

  it("drops a late response after a newer query, refresh or disposal", async () => {
    const old = deferred<WorkspaceFileSearchResult>();
    const search = vi.fn().mockReturnValueOnce(old.promise).mockImplementation(async (query: string) => found(query, ["new.ts"]));
    const files = new FileSearch(search);
    files.start(); files.setQuery("old"); await finishDebounce();
    files.setQuery("new"); await finishDebounce();
    old.resolve(found("old", ["old.ts"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(files.getSnapshot()).toMatchObject({ query: "new", entries: [entry("new.ts")] });
    const late = deferred<WorkspaceFileSearchResult>();
    search.mockReturnValueOnce(late.promise);
    files.refresh(); await finishDebounce();
    files.dispose();
    const before = files.getSnapshot();
    late.resolve(found("new", ["late.ts"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(files.getSnapshot()).toBe(before);
  });

  it("refresh repeats the current query and keeps it", async () => {
    const search = vi.fn().mockResolvedValueOnce(found(".ts", ["old.ts"])).mockResolvedValue(found(".ts", ["new.ts"]));
    const files = new FileSearch(search);
    files.start(); files.setQuery(".ts"); await finishDebounce();
    files.refresh(); await finishDebounce();
    expect(files.getSnapshot()).toMatchObject({ query: ".ts", entries: [entry("new.ts")] });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("reports partial walks and daemon failures", async () => {
    const search = vi.fn().mockResolvedValueOnce(found("file", ["file.ts"], { total: 900, incomplete: true, unreadable: true }))
      .mockRejectedValueOnce(new Error("Repository unavailable"));
    const files = new FileSearch(search);
    files.start(); files.setQuery("file"); await finishDebounce();
    expect(files.getSnapshot()).toMatchObject({ status: "ready", total: 900, incomplete: true, unreadable: true });
    files.refresh(); await finishDebounce();
    expect(files.getSnapshot()).toMatchObject({ status: "error", error: "Repository unavailable", entries: [], total: 0 });
  });
});
