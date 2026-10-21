// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDirectoryResult, WorkspaceFileReadResult, WorkspaceFileSearchParams, WorkspaceFileSearchResult, WorkspaceFilesParams } from "@termloop/contract/current";
import type { FilesSubject } from "../src/renderer/file-browser.js";
import { FilesOverlay } from "../src/renderer/ui/FilesOverlay.js";
import { FilesActivityBar, FilesSidebar, FilesSidebarResizeHandle } from "../src/renderer/ui/FilesSidebar.js";
import { useFileBrowser } from "../src/renderer/ui/use-file-browser.js";

const project: FilesSubject = { projectId: "project", taskId: null, title: "Project" };
const task: FilesSubject = { ...project, taskId: "task", title: "Task" };
const directory: WorkspaceDirectoryResult = { path: "", entries: [{ name: "sample.txt", path: "sample.txt", kind: "file" }], truncated: false };
const content = (value: string): WorkspaceFileReadResult => ({ path: "sample.txt", state: "text", content: value });

describe("Files sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  const list = vi.fn(async (_params: WorkspaceFilesParams) => directory);
  const read = vi.fn(async (_params: WorkspaceFilesParams) => content("Project file"));
  const noMatches = ({ query }: WorkspaceFileSearchParams): WorkspaceFileSearchResult => ({ query, entries: [], total: 0, incomplete: false, unreadable: false });
  const searchFiles = vi.fn(async (params: WorkspaceFileSearchParams) => noMatches(params));
  const selectRoot = vi.fn();
  const close = vi.fn();

  function Harness({ subject, identity = "root" }: { subject: FilesSubject | undefined; identity?: string }) {
    const { browser, snapshot } = useFileBrowser(subject, identity, list, read, searchFiles);
    return <>
      <FilesSidebar subject={subject} projectName="Project" tasks={[{ id: "task", title: "Task" }]}
        browser={browser} snapshot={snapshot} selectRoot={selectRoot}
        openFile={(path) => void browser.select(path)} close={close} unavailable={!subject} />
      <main><div data-terminal-host="true" />{subject && snapshot.preview.status !== "empty"
        ? <FilesOverlay subject={subject} preview={snapshot.preview} close={browser.clearPreview} /> : null}</main>
    </>;
  }
  const render = async (subject: FilesSubject | undefined, identity?: string) => {
    await act(async () => root.render(<Harness subject={subject} {...(identity ? { identity } : {})} />));
  };
  const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;
  const clickFile = async () => { await act(async () => button('[role="treeitem"]').click()); };
  const searchInput = () => container.querySelector<HTMLInputElement>('[aria-label="Search files"]')!;
  const search = async (query: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(searchInput(), query);
      searchInput().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(120));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    list.mockReset().mockResolvedValue(directory);
    read.mockReset().mockResolvedValue(content("Project file"));
    searchFiles.mockReset().mockImplementation(async (params) => noMatches(params));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("toggles the sidebar from the always-visible right activity bar", async () => {
    const toggle = vi.fn();
    await act(async () => root.render(<FilesActivityBar open={false} toggle={toggle} />));
    const filesButton = button('[aria-label="Files sidebar"]');
    expect(filesButton.getAttribute("aria-pressed")).toBe("false");
    await act(async () => filesButton.click());
    expect(toggle).toHaveBeenCalledOnce();
    await act(async () => root.render(<FilesActivityBar open toggle={toggle} />));
    expect(filesButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("searches inside the Explorer, collapses folders and closes", async () => {
    vi.useFakeTimers();
    list.mockImplementation(async ({ path }) => ({ path, truncated: false, entries: path === ""
      ? [{ name: "src", path: "src", kind: "directory" }]
      : [{ name: "nested.ts", path: "src/nested.ts", kind: "file" }] }));
    searchFiles.mockImplementation(async ({ query }) => ({ query, entries: [{ name: "nested.ts", path: "src/nested.ts", kind: "file" }], total: 1, incomplete: false, unreadable: false }));
    await render(project);
    const tree = () => container.querySelector('[aria-label="Workspace files"]');
    expect(container.querySelector('[role="tab"]')).toBeNull();
    await act(async () => button('[role="treeitem"]').click());
    expect(tree()?.textContent).toBe("srcnested.ts");
    expect(container.querySelectorAll(".files-tree-guide")).toHaveLength(1);
    await search("nested");
    expect(tree()).toBeNull();
    expect(container.querySelector('[aria-label="File search results"]')?.textContent).toContain("nested.ts");
    expect(button('[aria-label="Collapse all folders"]').getAttribute("aria-disabled")).toBe("true");
    await act(async () => button('[aria-label="Clear file search"]').click());
    expect(tree()?.textContent).toBe("srcnested.ts");
    await act(async () => button('[aria-label="Collapse all folders"]').click());
    expect(tree()?.textContent).toBe("src");
    expect(button('[aria-label="Collapse all folders"]').getAttribute("aria-disabled")).toBe("true");
    await act(async () => button('[aria-label="Close Files sidebar"]').click());
    expect(close).toHaveBeenCalledOnce();
  });

  it("resizes from its left edge with the pointer and the keyboard", async () => {
    const resize = vi.fn();
    await act(async () => root.render(<FilesSidebarResizeHandle width={300} maximum={500} resize={resize} reset={() => {}} draggingChanged={() => {}} />));
    const handle = container.querySelector<HTMLElement>('[aria-label="Resize Files sidebar"]')!;
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true })));
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(resize.mock.calls).toEqual([[310], [260], [500]]);
  });

  it("keeps the tree in the sidebar and closes only the preview without replacing terminal hosts", async () => {
    await render(project);
    const terminal = container.querySelector("[data-terminal-host]");
    expect(container.querySelector('aside [role="tree"]')).not.toBeNull();
    expect(container.querySelector('main [role="tree"]')).toBeNull();
    expect(container.querySelector('[aria-label="File preview"]')).toBeNull();
    await clickFile();
    expect(container.querySelector("main")?.textContent).toContain("Project file");
    await act(async () => button('[aria-label="Refresh files"]').click());
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => container.querySelector('[aria-label="File browser"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[aria-label="File preview"]')).toBeNull();
    expect(container.querySelector('aside [role="tree"]')).not.toBeNull();
    expect(container.querySelector("[data-terminal-host]")).toBe(terminal);
  });

  it("isolates Task roots and discards responses after leaving Files", async () => {
    let resolve!: (value: WorkspaceFileReadResult) => void;
    read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render(project);
    await clickFile();
    const picker = container.querySelector<HTMLSelectElement>('[aria-label="File root"]')!;
    await act(async () => { picker.value = "task"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(selectRoot).toHaveBeenCalledWith("task");
    await render(task);
    expect(list).toHaveBeenLastCalledWith({ projectId: "project", taskId: "task", path: "" });
    await act(async () => resolve(content("Old Project content")));
    expect(container.textContent).not.toContain("Old Project content");
    await clickFile();
    expect(read).toHaveBeenLastCalledWith({ projectId: "project", taskId: "task", path: "sample.txt" });
    const count = list.mock.calls.length;
    await render(undefined);
    expect(container.querySelector('[role="tree"]')).toBeNull();
    expect(container.querySelector('[aria-label="File preview"]')).toBeNull();
    expect(list).toHaveBeenCalledTimes(count);
    await render(task, "new-worktree-generation");
    expect(list).toHaveBeenCalledTimes(count + 1);
    expect(container.querySelector('[aria-label="File preview"]')).toBeNull();
  });

  it("searches closed folders, opens keyboard results, refreshes and clears on Escape", async () => {
    vi.useFakeTimers();
    list.mockImplementation(async ({ path }) => ({ path, truncated: false, entries: path === ""
      ? [{ name: "src", path: "src", kind: "directory" }]
      : [{ name: "nested.ts", path: "src/nested.ts", kind: "file" }] }));
    searchFiles.mockImplementation(async ({ query }) => ({ query, entries: [{ name: "nested.ts", path: "src/nested.ts", kind: "file" }], total: 1, incomplete: false, unreadable: false }));
    await render(project);
    const terminal = container.querySelector("[data-terminal-host]");
    await search("SRC NESTED");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("1 match");
    expect(container.querySelector('[aria-label="File search results"]')?.textContent).toContain("nested.ts");
    expect(read).not.toHaveBeenCalled();
    expect(searchFiles).toHaveBeenLastCalledWith({ projectId: "project", taskId: null, query: "SRC NESTED" });
    expect(list.mock.calls.filter(([params]) => params.path === "src")).toHaveLength(0);
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(button('[role="treeitem"]'));
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(read).toHaveBeenLastCalledWith({ projectId: "project", taskId: null, path: "src/nested.ts" });
    await act(async () => button('[aria-label="Refresh files"]').click());
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(searchInput().value).toBe("SRC NESTED");
    expect(searchFiles).toHaveBeenCalledTimes(2);
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(searchInput().value).toBe("");
    expect(document.activeElement).toBe(searchInput());
    expect(container.querySelector('[aria-label="File search results"]')).toBeNull();
    expect(container.querySelector('[aria-label="File preview"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Workspace files"]')?.textContent).toBe("src");
    expect(container.querySelector("[data-terminal-host]")).toBe(terminal);
  });

  it("shows no matches, clears the query and resets search when the root changes", async () => {
    vi.useFakeTimers();
    await render(project);
    await search("missing");
    expect(container.textContent).toContain("No matching files.");
    await act(async () => button('[aria-label="Clear file search"]').click());
    expect(searchInput().value).toBe("");
    expect(container.querySelector('[aria-label="Workspace files"]')).not.toBeNull();
    await search("sample");
    await render(task);
    expect(searchInput().value).toBe("");
    expect(container.querySelector('[aria-label="File search results"]')).toBeNull();
    await render(undefined);
    expect(searchInput().disabled).toBe(true);
    expect(container.textContent).toContain("Connect to this computer to browse files.");
  });

  it("shows the daemon's top results with the full match count and partial-walk notice", async () => {
    vi.useFakeTimers();
    searchFiles.mockImplementation(async ({ query }) => ({ query, total: 401, incomplete: true, unreadable: false,
      entries: Array.from({ length: 200 }, (_, i) => ({ name: `Subscription-${i}.cs`, path: `Subscription-${i}.cs`, kind: "file" as const })) }));
    await render(project);
    await search("subscription");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("401 matches · top 200 shown");
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(200);
    expect(container.textContent).toContain("Results may be incomplete.");
    await clickFile();
    expect(read).toHaveBeenLastCalledWith({ projectId: "project", taskId: null, path: "Subscription-0.cs" });
    expect(list.mock.calls.every(([params]) => params.path === "")).toBe(true);
  });

  it("shows a daemon search failure without hiding the query", async () => {
    vi.useFakeTimers();
    searchFiles.mockRejectedValue(new Error("Repository unavailable"));
    await render(project);
    await search("anything");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Repository unavailable");
    expect(searchInput().value).toBe("anything");
  });
});
