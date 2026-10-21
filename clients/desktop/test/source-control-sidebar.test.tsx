// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorktreeChangeListResult, SourceControlBranchDto, SourceControlStatusResult, TaskWorktreeChangeEntryDto, TaskWorktreeDiffResult } from "@termloop/contract/current";
import { SourceControlStatus, sourceControlPrimary, sourceControlSections, type SourceControlApi, type SourceControlSubject } from "../src/renderer/source-control-status.js";
import { ChangesOverlay } from "../src/renderer/ui/ChangesOverlay.js";
import { SourceControlSidebar } from "../src/renderer/ui/SourceControlSidebar.js";
import { SOURCE_CONTROL_POLL_MS, useSourceControl } from "../src/renderer/ui/use-source-control.js";

const entry = (id: string, path: string, side: TaskWorktreeChangeEntryDto["side"], kind: TaskWorktreeChangeEntryDto["kind"]): TaskWorktreeChangeEntryDto => ({
  entry_id: id, display_path: path, original_display_path: null, path_encoding: "utf8", side, kind, render_state: "available",
});
const changes = (entries: TaskWorktreeChangeEntryDto[], observation = "obs-1"): ProjectWorktreeChangeListResult => ({
  project_id: "project", observation_id: observation, entries, truncated: false,
});
const branchOf = (overrides: Partial<SourceControlBranchDto> = {}): SourceControlBranchDto => ({
  name: "feature/panel", head_state: "attached", upstream: "origin/feature/panel", upstream_gone: false, ahead: 1, behind: 0, ...overrides,
});
const status = (entries: TaskWorktreeChangeEntryDto[], observation = "obs-1", branch = branchOf(), taskId: string | null = null): SourceControlStatusResult => ({
  project_id: "project", task_id: taskId, observation_id: observation, branch, entries, truncated: false,
});
const sample = [
  entry("e1", "src/b.ts", "unstaged", "modified"),
  entry("e2", "src/a.ts", "staged", "added"),
  entry("e3", "src/b.ts", "staged", "modified"),
  entry("e4", "notes.md", "untracked", "untracked"),
  entry("e5", "conflict.txt", "staged", "unmerged"),
  entry("e6", "conflict.txt", "unstaged", "unmerged"),
];
const PROJECT: SourceControlSubject = { projectId: "project", taskId: null };
const sync = (action: "push" | "publish" | "pull" | "fetch") => ({ project_id: "project", task_id: null, action });
const mockApi = () => ({
  status: vi.fn(async (_params: unknown) => status(sample)),
  stage: vi.fn(async (_params: unknown) => ({ project_id: "project", task_id: null })),
  unstage: vi.fn(async (_params: unknown) => ({ project_id: "project", task_id: null })),
  discard: vi.fn(async (_params: unknown) => ({ project_id: "project", task_id: null })),
  commit: vi.fn(async (_params: unknown) => ({ project_id: "project", task_id: null, head_oid: "0".repeat(40) })),
  push: vi.fn(async (_params: unknown) => sync("push")),
  pull: vi.fn(async (_params: unknown) => sync("pull")),
  fetch: vi.fn(async (_params: unknown) => sync("fetch")),
});

describe("Source Control sections", () => {
  it("pins conflicts first, then Changes, Staged and Untracked, keeping partially staged files in both", () => {
    expect(sourceControlSections(sample).map((section) => [section.id, section.entries.map((item) => item.entry_id)])).toEqual([
      ["conflicts", ["e5"]],
      ["changes", ["e1"]],
      ["staged", ["e2", "e3"]],
      ["untracked", ["e4"]],
    ]);
    expect(sourceControlSections([])).toEqual([]);
  });

  it("drops a response that arrives after a newer refresh or after disposal", async () => {
    const pending: ((value: SourceControlStatusResult) => void)[] = [];
    const api = { ...mockApi(), status: () => new Promise<SourceControlStatusResult>((resolve) => pending.push(resolve)) };
    const model = new SourceControlStatus(PROJECT, () => api);
    model.start();
    void model.refresh();
    pending[1]!(status([sample[0]!], "new"));
    await Promise.resolve();
    pending[0]!(status([], "old"));
    await Promise.resolve();
    expect(model.getSnapshot().result?.observation_id).toBe("new");
    void model.refresh();
    model.dispose();
    pending[2]!(status([], "late"));
    await Promise.resolve();
    expect(model.getSnapshot().result?.observation_id).toBe("new");
  });

  it("runs one action at a time, pushes only after a successful commit, and keeps the failure message", async () => {
    const api = mockApi();
    const model = new SourceControlStatus(PROJECT, () => api);
    model.start();
    await vi.waitFor(() => expect(model.getSnapshot().result).toBeDefined());
    let release!: () => void;
    api.stage.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ project_id: "project", task_id: null }); }));
    const first = model.stage([sample[0]!]);
    expect(model.getSnapshot().busy).toBe("stage");
    expect(await model.unstage([sample[1]!])).toBe(false);
    expect(api.unstage).not.toHaveBeenCalled();
    release();
    expect(await first).toBe(true);
    expect(api.stage).toHaveBeenCalledWith({ projectId: "project", taskId: null, observationId: "obs-1", entryIds: ["e1"] });

    expect(await model.commit("   ")).toBe(false);
    api.commit.mockRejectedValueOnce(new Error("Set your Git name and email before committing."));
    expect(await model.commit("Fix", true)).toBe(false);
    expect(api.push).not.toHaveBeenCalled();
    expect(model.getSnapshot().actionError).toBe("Set your Git name and email before committing.");
    expect(await model.commit("Fix", true)).toBe(true);
    expect(api.commit).toHaveBeenLastCalledWith({ projectId: "project", taskId: null, message: "Fix" });
    expect(api.push).toHaveBeenCalledWith({ projectId: "project", taskId: null });
    expect(model.getSnapshot().actionError).toBeUndefined();
    model.dispose();
  });

  it("offers commit while anything is staged, otherwise the branch's sync action", () => {
    expect(sourceControlPrimary(branchOf(), 2, false)).toEqual({ kind: "commit", enabled: false });
    expect(sourceControlPrimary(branchOf(), 2, true)).toEqual({ kind: "commit", enabled: true });
    expect(sourceControlPrimary(branchOf({ upstream: null, ahead: null, behind: null }), 0, false)).toEqual({ kind: "publish" });
    expect(sourceControlPrimary(branchOf({ upstream_gone: true }), 0, false)).toEqual({ kind: "publish" });
    expect(sourceControlPrimary(branchOf({ ahead: 2 }), 0, false)).toEqual({ kind: "push", ahead: 2 });
    expect(sourceControlPrimary(branchOf({ ahead: 0, behind: 3 }), 0, false)).toEqual({ kind: "pull", behind: 3 });
    expect(sourceControlPrimary(branchOf({ ahead: 1, behind: 3 }), 0, false)).toEqual({ kind: "sync", ahead: 1, behind: 3 });
    expect(sourceControlPrimary(branchOf({ ahead: 0 }), 0, false)).toEqual({ kind: "none" });
    expect(sourceControlPrimary(branchOf({ head_state: "detached", name: null }), 0, false)).toEqual({ kind: "none" });
  });
});

describe("Source Control sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof mockApi>;
  const openChange = vi.fn();
  const openAll = vi.fn();
  const selectRoot = vi.fn();

  function Harness({ subject, signal = "1" }: { subject: SourceControlSubject | undefined; signal?: string }) {
    const { status: model, snapshot } = useSourceControl(subject, signal, api as SourceControlApi);
    return <SourceControlSidebar subject={subject} projectName="Project" tasks={[{ id: "task", title: "Task" }]}
      selectedTaskId={subject?.taskId ?? null} snapshot={snapshot} actions={model}
      selectRoot={selectRoot} openChange={openChange} openAll={openAll} close={() => {}}
      unavailable={!subject} />;
  }
  const render = async (subject: SourceControlSubject | undefined, signal?: string) => {
    await act(async () => root.render(<Harness subject={subject} {...(signal ? { signal } : {})} />));
  };
  const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;
  const click = async (selector: string) => { await act(async () => button(selector).click()); };
  const type = async (value: string) => {
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return textarea;
  };
  const primary = () => button(".source-control-primary-main");

  beforeEach(() => {
    vi.clearAllMocks();
    api = mockApi();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("lists the branch and grouped changes and opens the selected file for review", async () => {
    await render(PROJECT);
    expect(api.status).toHaveBeenCalledWith({ projectId: "project", taskId: null });
    expect(container.querySelector('[aria-label="Branch"]')?.textContent).toBe("feature/panel↑1");
    const titles = [...container.querySelectorAll(".source-control-section h3 > button span")].map((node) => node.textContent);
    expect(titles).toEqual(["Merge Changes", "Changes", "Staged Changes", "Untracked"]);
    const staged = container.querySelector('ul[aria-label="Staged Changes"]')!;
    expect([...staged.querySelectorAll(".source-control-row-name")].map((node) => node.textContent)).toEqual(["a.ts", "b.ts"]);
    await act(async () => staged.querySelector<HTMLButtonElement>(".source-control-row")!.click());
    expect(openChange).toHaveBeenCalledWith(sample[1]);
    await click('[aria-label="Review all changes"]');
    expect(openAll).toHaveBeenCalledOnce();
    await click(".source-control-section h3 > button");
    expect(container.querySelector('ul[aria-label="Merge Changes"]')).toBeNull();
  });

  it("stages, unstages, and discards one file or a whole section against the shown observation", async () => {
    await render(PROJECT);
    const entries = (params: unknown) => (params as { entryIds: string[] }).entryIds;
    await click('[aria-label="Stage src/b.ts"]');
    expect(api.stage).toHaveBeenLastCalledWith({ projectId: "project", taskId: null, observationId: "obs-1", entryIds: ["e1"] });
    await click('[aria-label="Unstage src/a.ts"]');
    expect(entries(api.unstage.mock.calls.at(-1)![0])).toEqual(["e2"]);
    await click('[aria-label="Mark conflict.txt as resolved"]');
    expect(entries(api.stage.mock.calls.at(-1)![0])).toEqual(["e5"]);
    await click('[aria-label="Unstage all changes"]');
    expect(entries(api.unstage.mock.calls.at(-1)![0])).toEqual(["e2", "e3"]);
    await click('[aria-label="Stage all untracked files"]');
    expect(entries(api.stage.mock.calls.at(-1)![0])).toEqual(["e4"]);

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await click('[aria-label="Discard all changes"]');
    expect(confirm).toHaveBeenLastCalledWith("Discard changes in src/b.ts? This cannot be undone.");
    expect(api.discard).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    await click('[aria-label="Delete notes.md"]');
    expect(confirm).toHaveBeenLastCalledWith("Delete notes.md? This file is not tracked by Git and cannot be restored.");
    expect(entries(api.discard.mock.calls.at(-1)![0])).toEqual(["e4"]);
    // Every action re-reads status: the initial load plus six actions.
    expect(api.status).toHaveBeenCalledTimes(7);
  });

  it("commits with Cmd+Enter or the primary button, clears the message, and shows a refusal", async () => {
    await render(PROJECT);
    expect(primary().textContent).toBe("Commit");
    expect(primary().getAttribute("aria-disabled")).toBe("true");
    const textarea = await type("Add the panel");
    expect(primary().getAttribute("aria-disabled")).toBe("false");
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
    expect(api.commit).toHaveBeenCalledWith({ projectId: "project", taskId: null, message: "Add the panel" });
    expect(textarea.value).toBe("");

    api.commit.mockRejectedValueOnce(new Error("A commit hook rejected this commit."));
    await type("Second");
    await click(".source-control-primary-main");
    expect(container.querySelector(".source-control-commit [role=alert]")?.textContent).toBe("A commit hook rejected this commit.");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Second");
  });

  it("offers publish, push, and pull from the primary button and fetch from the menu", async () => {
    api.status.mockResolvedValue(status([], "obs-1", branchOf({ upstream: null, ahead: null, behind: null })));
    await render(PROJECT);
    expect(container.querySelector('[aria-label="Branch"]')?.textContent).toBe("feature/panelNot published");
    expect(primary().textContent).toBe("Publish Branch");
    await click(".source-control-primary-main");
    expect(api.push).toHaveBeenCalledOnce();

    api.status.mockResolvedValue(status([], "obs-2", branchOf({ ahead: 0, behind: 2 })));
    await click('[aria-label="Refresh changes"]');
    expect(primary().textContent).toBe("Pull ↓2");
    await click(".source-control-primary-main");
    expect(api.pull).toHaveBeenCalledOnce();

    await click('[aria-label="More Source Control actions"]');
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Commit", "Commit & Push", "Push", "Pull", "Fetch"]);
    expect(items.slice(0, 2).every((item) => item.disabled)).toBe(true);
    await act(async () => items[4]!.click());
    expect(api.fetch).toHaveBeenCalledWith({ projectId: "project", taskId: null });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables actions while one is running", async () => {
    api.status.mockResolvedValue(status([sample[0]!]));
    await render(PROJECT);
    let release!: () => void;
    api.push.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(sync("push")); }));
    await click(".source-control-primary-main");
    expect(primary().textContent).toBe("Pushing…");
    expect(button('[aria-label="Stage src/b.ts"]').disabled).toBe(true);
    expect(button('[aria-label="More Source Control actions"]').disabled).toBe(true);
    await act(async () => { release(); });
    await vi.waitFor(() => expect(button('[aria-label="Stage src/b.ts"]').disabled).toBe(false));
  });

  it("refreshes on a moved daemon signal, window focus and the safety poll, but not on rerender", async () => {
    vi.useFakeTimers();
    await render(PROJECT, "1");
    expect(api.status).toHaveBeenCalledTimes(1);
    await render(PROJECT, "1");
    expect(api.status).toHaveBeenCalledTimes(1);
    await render(PROJECT, "2");
    expect(api.status).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(api.status).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_POLL_MS); });
    expect(api.status).toHaveBeenCalledTimes(4);
    api.status.mockResolvedValue(status([], "obs-t", branchOf(), "task"));
    await render({ projectId: "project", taskId: "task" }, "3");
    expect(api.status).toHaveBeenLastCalledWith({ projectId: "project", taskId: "task" });
    expect(api.status).toHaveBeenCalledTimes(5);
    expect(container.textContent).toContain("No changes in this checkout.");
  });

  it("explains an unavailable root and shows a failed read", async () => {
    await render(undefined);
    expect(container.textContent).toContain("Connect to this computer to see its changes.");
    expect(api.status).not.toHaveBeenCalled();
    api.status.mockRejectedValueOnce(new Error("Git is unavailable."));
    await render(PROJECT);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Git is unavailable.");
  });
});

describe("Changes review opened from Source Control", () => {
  it("selects the requested file instead of the first change", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const diff = vi.fn(async (_subject: string, observationId: string, entryId: string): Promise<TaskWorktreeDiffResult> => ({
      task_id: "project", observation_id: observationId, entry_id: entryId, state: "binary",
    } as unknown as TaskWorktreeDiffResult));
    await act(async () => root.render(<ChangesOverlay
      subject={{ id: "project", title: "Project", kind: "project", hasWorktree: true, hasBranch: false }}
      initialSource={{ kind: "local", entry: { path: "notes.md", side: "untracked" } }}
      close={() => {}}
      list={async () => changes(sample)}
      diff={diff}
      preImage={vi.fn()}
      listCommits={vi.fn()}
      listCommitChanges={vi.fn()}
      commitDiff={vi.fn()}
      gitHostProjection={undefined}
      listPullRequestChanges={vi.fn()}
      pullRequestDiff={vi.fn()}
      agentSessions={[]}
      sendReviewNotes={vi.fn()}
    />));
    expect(diff).toHaveBeenLastCalledWith("project", "obs-1", "e4");
    expect(container.querySelector('[aria-current="true"]')?.getAttribute("data-change-entry-id")).toBe("e4");
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
