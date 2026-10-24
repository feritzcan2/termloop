// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberQuickActionRun } from "../src/renderer/quick-action-memory.js";
import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

const NUCLEUS = { id: "project-nucleus", name: "Nucleus", folder_path: "/tmp/nucleus" };
const TERMLOOP = { id: "project-termloop", name: "TermLoop", folder_path: "/tmp/termloop" };

const composerProps = (selectedProject: typeof NUCLEUS | undefined) => ({
  projects: [NUCLEUS, TERMLOOP],
  selectedProject,
  capabilities: [fullAgentCapability("codex")],
  profiles: [],
  pasteImage: vi.fn(),
  restoreImage: vi.fn(),
  discardImage: vi.fn(),
  preview: vi.fn(),
  launch: vi.fn(),
  close: vi.fn(),
});

const runTarget = (container: HTMLElement) =>
  container.querySelector<HTMLSelectElement>('select[aria-label="Run in Project"]')?.value;

describe("Quick Action run target", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("targets the selected Project even after a run in another Project", async () => {
    rememberQuickActionRun(TERMLOOP.id, "codex", { model: "default", permission: "default", reasoning: "default" });

    await act(async () => root.render(createElement(QuickActionComposer, composerProps(NUCLEUS))));

    expect(runTarget(container)).toBe(NUCLEUS.id);
    expect(container.querySelector(".quick-action-header code")?.textContent).toContain(NUCLEUS.folder_path);
  });

  it("falls back to the last run Project when no Project is selected", async () => {
    rememberQuickActionRun(TERMLOOP.id, "codex", { model: "default", permission: "default", reasoning: "default" });

    await act(async () => root.render(createElement(QuickActionComposer, composerProps(undefined))));

    expect(runTarget(container)).toBe(TERMLOOP.id);
  });

  it("targets a Task worktree of the selected Project in Worktree mode", async () => {
    vi.useFakeTimers();
    const task = (id: string, projectId: string, worktree: string | null) => ({
      id, project_id: projectId, title: `Task ${id}`, branch: { repository_root: "/repo", name: `feature/${id}` },
      worktree: worktree ? { path: worktree } : null, archived_at_epoch_ms: null,
    });
    const preview = vi.fn().mockReturnValue(new Promise(() => undefined));
    const props = {
      ...composerProps(NUCLEUS),
      preview,
      tasks: [task("a", NUCLEUS.id, "/tmp/wt-a"), task("b", NUCLEUS.id, null), task("c", TERMLOOP.id, "/tmp/wt-c")],
    };

    await act(async () => root.render(createElement(QuickActionComposer, props as never)));
    const worktreeButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Worktree")!;
    expect(worktreeButton.disabled).toBe(false);
    await act(async () => worktreeButton.click());

    const choices = container.querySelector<HTMLSelectElement>('select[aria-label="Task worktree"]')!;
    expect([...choices.options].map((option) => option.value)).toEqual(["a"]);
    expect(container.querySelector(".quick-action-header code")?.textContent).toContain("/tmp/wt-a");

    const textarea = container.querySelector<HTMLTextAreaElement>("#quick-action-prompt")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "do it");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(preview).toHaveBeenLastCalledWith(NUCLEUS.id, "codex", expect.any(String), expect.any(String), expect.any(String), expect.any(String), "do it", [], undefined, "a");
    vi.useRealTimers();
  });

});
