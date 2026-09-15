import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceDirectoryResult, WorkspaceFileReadResult } from "@termloop/contract/current";
import { FileBrowser, fileTreeRows, type FileBrowserSnapshot } from "../src/renderer/file-browser.js";
import { FileContentPreview } from "../src/renderer/ui/FilesOverlay.js";
import { FileTree } from "../src/renderer/ui/FileTree.js";

const directory = (path: string, entries: WorkspaceDirectoryResult["entries"] = []): WorkspaceDirectoryResult => ({ path, entries, truncated: false });
const text = (path: string, content = path): WorkspaceFileReadResult => ({ path, content, state: "text" });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("Files observations", () => {
  it("keeps a closed preview closed when a read or refresh arrives later", async () => {
    const pendingRead = deferred<WorkspaceFileReadResult>();
    const pendingList = deferred<WorkspaceDirectoryResult>();
    const read = vi.fn().mockReturnValueOnce(pendingRead.promise).mockResolvedValue(text("file"));
    const list = vi.fn().mockResolvedValueOnce(directory("")).mockReturnValueOnce(pendingList.promise);
    const browser = new FileBrowser({ list, read });
    browser.start(); await settle();
    const selection = browser.select("file");
    browser.clearPreview();
    pendingRead.resolve(text("file")); await selection;
    expect(browser.getSnapshot().preview.status).toBe("empty");
    await browser.select("file");
    const refresh = browser.refresh(); await settle();
    browser.clearPreview();
    pendingList.resolve(directory("")); await refresh;
    expect(browser.getSnapshot().preview.status).toBe("empty");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("loads folders on demand and refreshes expanded directories plus the selection", async () => {
    const list = vi.fn(async (path: string) => path === ""
      ? directory("", [{ name: "src", path: "src", kind: "directory" }])
      : directory(path, [{ name: "app.ts", path: "src/app.ts", kind: "file" }]));
    const read = vi.fn(async (path: string) => text(path));
    const browser = new FileBrowser({ list, read });
    browser.start(); await settle();
    expect(list.mock.calls).toEqual([[""]]);
    browser.toggle("src"); await settle();
    expect(list.mock.calls).toEqual([[""], ["src"]]);
    await browser.select("src/app.ts");
    await browser.refresh();
    expect(list.mock.calls).toEqual([[""], ["src"], [""], ["src"]]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(browser.getSnapshot().expanded.has("src")).toBe(true);
    browser.toggle("src");
    expect(browser.getSnapshot().directories.has("src")).toBe(false);
    browser.dispose();
  });

  it("never replaces a new selection with an older file response", async () => {
    const first = deferred<WorkspaceFileReadResult>();
    const browser = new FileBrowser({ list: async () => directory(""), read: (path) => path === "first" ? first.promise : Promise.resolve(text(path)) });
    browser.start(); await settle();
    const old = browser.select("first");
    await browser.select("second");
    first.resolve(text("first")); await old;
    expect(browser.getSnapshot().preview).toMatchObject({ status: "ready", path: "second" });
  });

  it("discards old refresh responses and disposed observations", async () => {
    const old = deferred<WorkspaceDirectoryResult>();
    const list = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(directory("", [{ name: "new", path: "new", kind: "file" }]));
    const browser = new FileBrowser({ list, read: async (path) => text(path) });
    browser.start(); await settle();
    await browser.refresh();
    old.resolve(directory("", [{ name: "old", path: "old", kind: "file" }])); await settle();
    expect(fileTreeRows(browser.getSnapshot())).toMatchObject([{ entry: { name: "new" } }]);
    const before = browser.getSnapshot();
    browser.dispose();
    await browser.select("new");
    expect(browser.getSnapshot()).toBe(before);
  });

  it("prunes removed folders and shows failures with a working refresh", async () => {
    const list = vi.fn().mockResolvedValueOnce(directory("", [{ name: "gone", path: "gone", kind: "directory" }]))
      .mockRejectedValueOnce(new Error("Permission denied"))
      .mockResolvedValue(directory(""));
    const browser = new FileBrowser({ list, read: async () => { throw new Error("File removed"); } });
    browser.start(); await settle(); browser.toggle("gone"); await settle();
    expect(fileTreeRows(browser.getSnapshot())).toContainEqual({ kind: "message", path: "gone", depth: 1, message: "Permission denied", error: true });
    await browser.select("missing");
    expect(browser.getSnapshot().preview).toMatchObject({ status: "error", message: "File removed" });
    await browser.refresh();
    expect(browser.getSnapshot().expanded.size).toBe(0);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("supports strict effect cleanup and restart without remaining stuck loading", async () => {
    const list = vi.fn(async () => directory(""));
    const browser = new FileBrowser({ list, read: async (path) => text(path) });
    browser.start(); browser.dispose(); browser.start(); await settle();
    expect(browser.getSnapshot().refreshing).toBe(false);
    expect(browser.getSnapshot().directories.get("")?.status).toBe("ready");
  });

  it("does not retain a listing that arrives after its folder was closed", async () => {
    const child = deferred<WorkspaceDirectoryResult>();
    const browser = new FileBrowser({
      list: (path) => path === "" ? Promise.resolve(directory("", [{ name: "src", path: "src", kind: "directory" }])) : child.promise,
      read: async (path) => text(path),
    });
    browser.start(); await settle();
    browser.toggle("src"); browser.toggle("src");
    child.resolve(directory("src")); await settle();
    expect(browser.getSnapshot().directories.has("src")).toBe(false);
  });
});

describe("Files presentation", () => {
  it("renders accessible tree selection and explicit truncated-list notices", () => {
    const snapshot: FileBrowserSnapshot = {
      directories: new Map([["", { status: "ready", result: { ...directory("", [{ name: ".env", path: ".env", kind: "file" }]), truncated: true } }]]),
      expanded: new Set(), preview: { status: "ready", path: ".env", result: text(".env") }, refreshing: false,
    };
    const html = renderToStaticMarkup(createElement(FileTree, { snapshot, toggle() {}, select() {} }));
    expect(html).toContain('role="tree"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("Some entries are omitted");
  });

  it("escapes file text and explains every refusal", () => {
    const render = (result: WorkspaceFileReadResult) => renderToStaticMarkup(createElement(FileContentPreview, { preview: { status: "ready", path: result.path, result } }));
    const html = render(text("index.html", '<script>alert("x")</script>\n'));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(render(text("empty", ""))).toContain("Empty file");
    for (const [state, message] of [["binary", "binary"], ["tooLarge", "256 KiB"], ["symlink", "Symbolic links"], ["unsupported", "regular text files"]] as const) {
      expect(render({ path: "file", state, content: null })).toContain(message);
    }
  });
});
