// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWorktreeChangeListResult, TaskWorktreeChangeEntryDto, TaskWorktreeDiffResult } from "@termloop/contract/current";
import { SourceControlStatus, sourceControlSections, type SourceControlSubject } from "../src/renderer/source-control-status.js";
import { ChangesOverlay } from "../src/renderer/ui/ChangesOverlay.js";
import { SourceControlSidebar } from "../src/renderer/ui/SourceControlSidebar.js";
import { SOURCE_CONTROL_POLL_MS, useSourceControl } from "../src/renderer/ui/use-source-control.js";

const entry = (id: string, path: string, side: TaskWorktreeChangeEntryDto["side"], kind: TaskWorktreeChangeEntryDto["kind"]): TaskWorktreeChangeEntryDto => ({
  entry_id: id, display_path: path, original_display_path: null, path_encoding: "utf8", side, kind, render_state: "available",
});
const changes = (entries: TaskWorktreeChangeEntryDto[], observation = "obs-1"): ProjectWorktreeChangeListResult => ({
  project_id: "project", observation_id: observation, entries, truncated: false,
});
const sample = [
  entry("e1", "src/b.ts", "unstaged", "modified"),
  entry("e2", "src/a.ts", "staged", "added"),
  entry("e3", "src/b.ts", "staged", "modified"),
  entry("e4", "notes.md", "untracked", "untracked"),
  entry("e5", "conflict.txt", "staged", "unmerged"),
  entry("e6", "conflict.txt", "unstaged", "unmerged"),
];

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
    const pending: ((value: ProjectWorktreeChangeListResult) => void)[] = [];
    const status = new SourceControlStatus(() => new Promise((resolve) => pending.push(resolve)));
    status.start();
    void status.refresh();
    pending[1]!(changes([sample[0]!], "new"));
    await Promise.resolve();
    pending[0]!(changes([], "old"));
    await Promise.resolve();
    expect(status.getSnapshot().result?.observation_id).toBe("new");
    void status.refresh();
    status.dispose();
    pending[2]!(changes([], "late"));
    await Promise.resolve();
    expect(status.getSnapshot().result?.observation_id).toBe("new");
  });
});

describe("Source Control sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  const listProject = vi.fn(async (_projectId: string) => changes(sample));
  const listTask = vi.fn(async (_taskId: string) => ({ ...changes([]), task_id: "task", worktree_generation: 1 }));
  const openChange = vi.fn();
  const openAll = vi.fn();
  const selectRoot = vi.fn();

  function Harness({ subject, signal = "1" }: { subject: SourceControlSubject | undefined; signal?: string }) {
    const { status, snapshot } = useSourceControl(subject, signal, listProject, listTask);
    return <SourceControlSidebar subject={subject} projectName="Project" tasks={[{ id: "task", title: "Task" }]}
      selectedTaskId={subject?.kind === "task" ? subject.id : null} snapshot={snapshot} branch="feature/panel" upstream="ahead"
      selectRoot={selectRoot} refresh={() => { void status.refresh(); }} openChange={openChange} openAll={openAll} close={() => {}}
      unavailable={!subject} />;
  }
  const render = async (subject: SourceControlSubject | undefined, signal?: string) => {
    await act(async () => root.render(<Harness subject={subject} {...(signal ? { signal } : {})} />));
  };
  const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;

  beforeEach(() => {
    vi.clearAllMocks();
    listProject.mockReset().mockResolvedValue(changes(sample));
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

  it("lists the branch and grouped changes and opens the selected file for review", async () => {
    await render({ kind: "project", id: "project" });
    expect(listProject).toHaveBeenCalledWith("project");
    expect(container.querySelector('[aria-label="Branch"]')?.textContent).toBe("feature/panelAhead of upstream");
    const titles = [...container.querySelectorAll(".source-control-section h3 span")].map((node) => node.textContent);
    expect(titles).toEqual(["Merge Changes", "Changes", "Staged Changes", "Untracked"]);
    const staged = container.querySelector('ul[aria-label="Staged Changes"]')!;
    expect([...staged.querySelectorAll(".source-control-row-name")].map((node) => node.textContent)).toEqual(["a.ts", "b.ts"]);
    await act(async () => staged.querySelector<HTMLButtonElement>("button")!.click());
    expect(openChange).toHaveBeenCalledWith(sample[1]);
    await act(async () => button('[aria-label="Review all changes"]').click());
    expect(openAll).toHaveBeenCalledOnce();
    await act(async () => button('.source-control-section h3 button').click());
    expect(container.querySelector('ul[aria-label="Merge Changes"]')).toBeNull();
  });

  it("refreshes on a moved daemon signal, window focus and the safety poll, but not on rerender", async () => {
    vi.useFakeTimers();
    await render({ kind: "project", id: "project" }, "1");
    expect(listProject).toHaveBeenCalledTimes(1);
    await render({ kind: "project", id: "project" }, "1");
    expect(listProject).toHaveBeenCalledTimes(1);
    await render({ kind: "project", id: "project" }, "2");
    expect(listProject).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(listProject).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_POLL_MS); });
    expect(listProject).toHaveBeenCalledTimes(4);
    await render({ kind: "task", id: "task" }, "3");
    expect(listTask).toHaveBeenCalledWith("task");
    expect(listProject).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("No changes in this checkout.");
  });

  it("explains an unavailable root and shows a failed read", async () => {
    await render(undefined);
    expect(container.textContent).toContain("Connect to this computer to see its changes.");
    expect(listProject).not.toHaveBeenCalled();
    listProject.mockRejectedValueOnce(new Error("Git is unavailable."));
    await render({ kind: "project", id: "project" });
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
