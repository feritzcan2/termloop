// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDirectoryResult, WorkspaceFileReadResult, WorkspaceFilesParams } from "@termloop/contract/current";
import type { FilesSubject } from "../src/renderer/file-browser.js";
import { FilesOverlay } from "../src/renderer/ui/FilesOverlay.js";
import { FilesRail } from "../src/renderer/ui/FilesRail.js";
import { useFileBrowser } from "../src/renderer/ui/use-file-browser.js";
import { WorkspaceViewSwitch } from "../src/renderer/ui/WorkspaceViewSwitch.js";

const project: FilesSubject = { projectId: "project", taskId: null, title: "Project" };
const task: FilesSubject = { ...project, taskId: "task", title: "Task" };
const directory: WorkspaceDirectoryResult = { path: "", entries: [{ name: "sample.txt", path: "sample.txt", kind: "file" }], truncated: false };
const content = (value: string): WorkspaceFileReadResult => ({ path: "sample.txt", state: "text", content: value });

describe("Files sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  const list = vi.fn(async (_params: WorkspaceFilesParams) => directory);
  const read = vi.fn(async (_params: WorkspaceFilesParams) => content("Project file"));
  const selectRoot = vi.fn();

  function Harness({ subject, identity = "root" }: { subject: FilesSubject | undefined; identity?: string }) {
    const { browser, snapshot } = useFileBrowser(subject, identity, list, read);
    return <>
      <aside><FilesRail subject={subject} projectName="Project" tasks={[{ id: "task", title: "Task" }]}
        browser={browser} snapshot={snapshot} selectRoot={selectRoot} openFile={(path) => void browser.select(path)} unavailable={!subject} /></aside>
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
    await act(async () => vi.advanceTimersByTimeAsync(180));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    list.mockReset().mockResolvedValue(directory);
    read.mockReset().mockResolvedValue(content("Project file"));
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

  it("places Files after Steward and selects it independently", async () => {
    const select = vi.fn();
    await act(async () => root.render(<WorkspaceViewSwitch view="files" disabled={false} select={select}
      launchTerminal={async () => {}} launchAgent={async () => {}} />));
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["Agents", "Tasks", "✦Steward", "Files"]);
    const filesTab = button('[aria-label="Project files view"]');
    expect(filesTab.getAttribute("aria-selected")).toBe("true");
    await act(async () => filesTab.click());
    expect(select).toHaveBeenCalledWith("files");
    expect(container.querySelector('[aria-label="Launch Session"]')).toBeNull();
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

  it("searches closed folders, opens keyboard results, refreshes and restores the tree on Escape", async () => {
    vi.useFakeTimers();
    list.mockImplementation(async ({ path }) => ({ path, truncated: false, entries: path === ""
      ? [{ name: "src", path: "src", kind: "directory" }]
      : [{ name: "nested.ts", path: "src/nested.ts", kind: "file" }] }));
    await render(project);
    const terminal = container.querySelector("[data-terminal-host]");
    await search("SRC NESTED");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("1 match");
    expect(container.querySelector('[aria-label="File search results"]')?.textContent).toContain("nested.ts");
    expect(read).not.toHaveBeenCalled();
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(button('[role="treeitem"]'));
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(read).toHaveBeenLastCalledWith({ projectId: "project", taskId: null, path: "src/nested.ts" });
    await act(async () => button('[aria-label="Refresh files"]').click());
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(searchInput().value).toBe("SRC NESTED");
    expect(list.mock.calls.filter(([params]) => params.path === "src")).toHaveLength(2);
    await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(searchInput().value).toBe("");
    expect(document.activeElement).toBe(searchInput());
    expect(container.querySelector('[aria-label="Workspace files"]')?.textContent).toBe("src");
    expect(container.querySelector('[aria-label="File preview"]')).not.toBeNull();
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
  });

  it("exposes every match across result pages without rescanning the project", async () => {
    vi.useFakeTimers();
    list.mockResolvedValue({ path: "", truncated: false, entries: Array.from({ length: 401 }, (_, i) => ({ name: `Subscription-${i}.cs`, path: `Subscription-${i}.cs`, kind: "file" })) });
    await render(project);
    await search("subscription");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("401 matches");
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(200);
    const calls = list.mock.calls.length;
    await act(async () => button('[aria-label="Next file results"]').click());
    expect(container.textContent).toContain("Page 2 of 3");
    await act(async () => button('[aria-label="Next file results"]').click());
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    await clickFile();
    expect(read).toHaveBeenLastCalledWith({ projectId: "project", taskId: null, path: "Subscription-400.cs" });
    expect(list).toHaveBeenCalledTimes(calls);
    await act(async () => button('[aria-label="Previous file results"]').click());
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(200);
  });
});
