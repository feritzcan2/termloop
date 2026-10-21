// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { WorkspaceDirectoryResult, WorkspaceFileReadResult, WorkspaceFileSearchParams, WorkspaceFileSearchResult, WorkspaceFilesParams, WorkspaceFileWriteParams, WorkspaceFileWriteResult } from "@termloop/contract/current";
import type { FilesSubject } from "../src/renderer/file-browser.js";
import { FileEditorOverlay } from "../src/renderer/ui/FileEditorOverlay.js";
import { FilesSidebar, FilesSidebarResizeHandle } from "../src/renderer/ui/FilesSidebar.js";
import { RightActivityBar } from "../src/renderer/ui/RightActivityBar.js";
import { useFileBrowser } from "../src/renderer/ui/use-file-browser.js";
import { useFileEditor } from "../src/renderer/ui/use-file-editor.js";
import { fakeMonaco } from "./monaco-fixture.js";

const fake = vi.hoisted(() => ({ current: undefined as ReturnType<typeof import("./monaco-fixture.js").fakeMonaco> | undefined }));
vi.mock("../src/renderer/monaco-editor.js", () => ({ get monaco() { return fake.current!.monaco; } }));

const project: FilesSubject = { projectId: "project", taskId: null, title: "Project" };
const task: FilesSubject = { ...project, taskId: "task", title: "Task" };
const directory: WorkspaceDirectoryResult = { path: "", entries: [{ name: "sample.txt", path: "sample.txt", kind: "file" }], truncated: false };
const content = (value: string): WorkspaceFileReadResult => ({ path: "sample.txt", state: "text", content: value, version: "1".repeat(64) });

describe("Files sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  const list = vi.fn(async (_params: WorkspaceFilesParams) => directory);
  const read = vi.fn(async (_params: WorkspaceFilesParams) => content("Project file"));
  const write = vi.fn(async ({ path }: WorkspaceFileWriteParams): Promise<WorkspaceFileWriteResult> => ({ path, state: "written", version: "2".repeat(64) }));
  const noMatches = ({ query }: WorkspaceFileSearchParams): WorkspaceFileSearchResult => ({ query, entries: [], total: 0, incomplete: false, unreadable: false });
  const searchFiles = vi.fn(async (params: WorkspaceFileSearchParams) => noMatches(params));
  const selectRoot = vi.fn();
  const close = vi.fn();

  function Harness({ subject, identity = "root", readOnly = false }: { subject: FilesSubject | undefined; identity?: string; readOnly?: boolean }) {
    const { browser, snapshot } = useFileBrowser(subject, identity, list, searchFiles);
    const files = useFileEditor(subject, identity, read, write);
    const [shown, setShown] = useState(false);
    const visible = Boolean(subject && shown && files.snapshot.tabs.length);
    return <>
      <FilesSidebar subject={subject} projectName="Project" tasks={[{ id: "task", title: "Task" }]}
        browser={browser} snapshot={snapshot} selectedPath={visible ? files.snapshot.active : undefined} selectRoot={selectRoot}
        openFile={(path) => { files.editor.open(path); setShown(true); }} dismiss={() => setShown(false)} close={close} unavailable={!subject} />
      <main><div data-terminal-host="true" />{visible && subject
        ? <FileEditorOverlay subject={subject} editor={files.editor} snapshot={files.snapshot} readOnly={readOnly}
          hide={() => setShown(false)} closeTab={(path) => files.editor.close(path)} /> : null}</main>
    </>;
  }
  const render = async (subject: FilesSubject | undefined, identity?: string, readOnly?: boolean) => {
    await act(async () => root.render(<Harness subject={subject} {...(identity ? { identity } : {})} {...(readOnly ? { readOnly } : {})} />));
  };
  const editorOpen = () => container.querySelector('[aria-label^="Editor for"]') !== null;
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
    write.mockClear();
    fake.current = fakeMonaco();
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

  it("switches between Files and Source Control from the always-visible right activity bar", async () => {
    const select = vi.fn();
    await act(async () => root.render(<RightActivityBar open={false} view="files" select={select} />));
    const filesButton = button('[aria-label="Files sidebar"]');
    const gitButton = button('[aria-label="Source Control sidebar"]');
    expect(filesButton.getAttribute("aria-pressed")).toBe("false");
    await act(async () => gitButton.click());
    expect(select).toHaveBeenCalledWith("sourceControl");
    await act(async () => root.render(<RightActivityBar open view="sourceControl" select={select} />));
    expect(filesButton.getAttribute("aria-pressed")).toBe("false");
    expect(gitButton.getAttribute("aria-pressed")).toBe("true");
    expect(gitButton.title).toBe("Hide Source Control");
    expect([...container.querySelectorAll(".files-activity-bar button")].map((item) => item.getAttribute("aria-label")))
      .toEqual(["Files sidebar", "Source Control sidebar", "Steward sidebar", "Pull Requests sidebar", "Agents sidebar", "Skills sidebar", "Context sidebar"]);
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

  it("edits a file in a tab over the stage, saves with ⌘S and hides without replacing terminal hosts", async () => {
    await render(project);
    const terminal = container.querySelector("[data-terminal-host]");
    expect(container.querySelector('main [role="tree"]')).toBeNull();
    expect(editorOpen()).toBe(false);
    await clickFile();
    expect(container.querySelector('[role="tab"]')?.textContent).toBe("sample.txt");
    expect(button('[role="treeitem"]').getAttribute("aria-selected")).toBe("true");
    expect(fake.current!.state.model).toMatchObject({ value: "Project file", language: "plaintext" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved");
    await act(async () => fake.current!.type("Edited"));
    expect(container.querySelector('[aria-label="Close sample.txt (unsaved changes)"]')).not.toBeNull();
    await act(async () => fake.current!.save());
    expect(write).toHaveBeenCalledWith({ projectId: "project", taskId: null, path: "sample.txt", content: "Edited", expectedVersion: "1".repeat(64) });
    expect(container.querySelector('[aria-label="Close sample.txt"]')).not.toBeNull();
    await act(async () => container.querySelector('[aria-label="File browser"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(editorOpen()).toBe(false);
    expect(container.querySelector('aside [role="tree"]')).not.toBeNull();
    expect(container.querySelector("[data-terminal-host]")).toBe(terminal);
    await clickFile();
    expect(fake.current!.models.filter((model) => !model.disposed)).toHaveLength(1);
  });

  it("offers reload or overwrite on a conflict and stays read-only for read-only computers", async () => {
    write.mockResolvedValueOnce({ path: "sample.txt", state: "conflict", version: "9".repeat(64) });
    await render(project);
    await clickFile();
    await act(async () => fake.current!.type("Mine"));
    await act(async () => fake.current!.save());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed on disk");
    await act(async () => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "Overwrite")!.click());
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ content: "Mine", expectedVersion: "9".repeat(64) }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await render(project, "root", true);
    expect(fake.current!.state.readOnly).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Read-only");
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
    expect(fake.current!.models.some((model) => model.value === "Old Project content")).toBe(false);
    await clickFile();
    expect(read).toHaveBeenLastCalledWith({ projectId: "project", taskId: "task", path: "sample.txt" });
    const count = list.mock.calls.length;
    await render(undefined);
    expect(container.querySelector('[role="tree"]')).toBeNull();
    expect(editorOpen()).toBe(false);
    expect(list).toHaveBeenCalledTimes(count);
    await render(task, "new-worktree-generation");
    expect(list).toHaveBeenCalledTimes(count + 1);
    expect(editorOpen()).toBe(false);
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
    expect(editorOpen()).toBe(true);
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
