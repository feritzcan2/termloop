import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceDirectoryResult, WorkspaceFileSearchResult } from "@termloop/contract/current";
import { FILE_LIST_RETRY_DELAYS_MS, FileBrowser, fileTreeRows, type FileBrowserSnapshot } from "../src/renderer/file-browser.js";
import { FileTree } from "../src/renderer/ui/FileTree.js";

const directory = (path: string, entries: WorkspaceDirectoryResult["entries"] = []): WorkspaceDirectoryResult => ({ path, entries, truncated: false });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; };
const search = async (query: string): Promise<WorkspaceFileSearchResult> => ({ query, entries: [], total: 0, incomplete: false, unreadable: false });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("Files observations", () => {
  it("loads folders on demand and refreshes expanded directories", async () => {
    const list = vi.fn(async (path: string) => path === ""
      ? directory("", [{ name: "src", path: "src", kind: "directory" }])
      : directory(path, [{ name: "app.ts", path: "src/app.ts", kind: "file" }]));
    const browser = new FileBrowser({ list, search });
    browser.start(); await settle();
    expect(list.mock.calls).toEqual([[""]]);
    browser.toggle("src"); await settle();
    expect(list.mock.calls).toEqual([[""], ["src"]]);
    await browser.refresh();
    expect(list.mock.calls).toEqual([[""], ["src"], [""], ["src"]]);
    expect(browser.getSnapshot().expanded.has("src")).toBe(true);
    browser.toggle("src");
    expect(browser.getSnapshot().directories.has("src")).toBe(false);
    browser.dispose();
  });

  it("discards old refresh responses and disposed observations", async () => {
    const old = deferred<WorkspaceDirectoryResult>();
    const list = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(directory("", [{ name: "new", path: "new", kind: "file" }]));
    const browser = new FileBrowser({ list, search });
    browser.start(); await settle();
    await browser.refresh();
    old.resolve(directory("", [{ name: "old", path: "old", kind: "file" }])); await settle();
    expect(fileTreeRows(browser.getSnapshot())).toMatchObject([{ entry: { name: "new" } }]);
    const before = browser.getSnapshot();
    browser.dispose();
    await browser.refresh();
    expect(browser.getSnapshot()).toBe(before);
  });

  it("prunes removed folders and shows failures with a working refresh", async () => {
    const list = vi.fn().mockResolvedValueOnce(directory("", [{ name: "gone", path: "gone", kind: "directory" }]))
      .mockRejectedValueOnce(new Error("Permission denied"))
      .mockResolvedValue(directory(""));
    const browser = new FileBrowser({ list, search });
    browser.start(); await settle(); browser.toggle("gone"); await settle();
    expect(fileTreeRows(browser.getSnapshot())).toContainEqual({ kind: "message", path: "gone", depth: 1, message: "Permission denied", error: true });
    await browser.refresh();
    expect(browser.getSnapshot().expanded.size).toBe(0);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("supports strict effect cleanup and restart without remaining stuck loading", async () => {
    const list = vi.fn(async () => directory(""));
    const browser = new FileBrowser({ list, search });
    browser.start(); browser.dispose(); browser.start(); await settle();
    expect(browser.getSnapshot().refreshing).toBe(false);
    expect(browser.getSnapshot().directories.get("")?.status).toBe("ready");
  });

  it("does not retain a listing that arrives after its folder was closed", async () => {
    const child = deferred<WorkspaceDirectoryResult>();
    const browser = new FileBrowser({
      list: (path) => path === "" ? Promise.resolve(directory("", [{ name: "src", path: "src", kind: "directory" }])) : child.promise,
      search,
    });
    browser.start(); await settle();
    browser.toggle("src"); browser.toggle("src");
    child.resolve(directory("src")); await settle();
    expect(browser.getSnapshot().directories.has("src")).toBe(false);
  });

  it("keeps loading while the daemon's observation queue is busy and then explains it", async () => {
    vi.useFakeTimers();
    try {
      const unavailable = new Error("Error invoking remote method 'termloop:workspace-directory-list': TermLoopControlError: repository is unavailable");
      const list = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce(directory("", [{ name: "a.ts", path: "a.ts", kind: "file" }]));
      const browser = new FileBrowser({ list, search });
      browser.start(); await settle();
      expect(browser.getSnapshot().directories.get("")?.status).toBe("loading");
      await vi.advanceTimersByTimeAsync(FILE_LIST_RETRY_DELAYS_MS[0]!);
      expect(fileTreeRows(browser.getSnapshot())).toMatchObject([{ entry: { name: "a.ts" } }]);

      list.mockReset().mockRejectedValue(unavailable);
      const refreshed = browser.refresh();
      await vi.runAllTimersAsync(); await refreshed;
      expect(list).toHaveBeenCalledTimes(FILE_LIST_RETRY_DELAYS_MS.length + 1);
      expect(fileTreeRows(browser.getSnapshot())).toEqual([{ kind: "message", path: "", depth: 0, message: "The daemon is still busy reading this project. Try Refresh.", error: true }]);

      list.mockReset().mockRejectedValue(new Error("Error invoking remote method 'termloop:workspace-directory-list': TermLoopControlError: invalid workspace path"));
      await browser.refresh();
      expect(list).toHaveBeenCalledOnce();
      expect(fileTreeRows(browser.getSnapshot())).toMatchObject([{ message: "invalid workspace path" }]);
      browser.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("Files presentation", () => {
  it("renders accessible tree selection and explicit truncated-list notices", () => {
    const snapshot: FileBrowserSnapshot = {
      directories: new Map([["", { status: "ready", result: { ...directory("", [{ name: ".env", path: ".env", kind: "file" }]), truncated: true } }]]),
      expanded: new Set(), refreshing: false,
    };
    const html = renderToStaticMarkup(createElement(FileTree, { snapshot, selectedPath: ".env", toggle() {}, select() {} }));
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Some entries are omitted");
  });
});
