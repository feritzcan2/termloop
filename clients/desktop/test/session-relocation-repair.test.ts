// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectableLaunchManifest, SessionRelocationPreviewDto } from "@termloop/contract/current";
import type { Session, Task } from "../src/renderer/model.js";
import { SessionRelocationDialog } from "../src/renderer/ui/SessionRelocationDialog.js";
import { BackgroundSessionRelocation, type BackgroundSessionRelocationIntent } from "../src/renderer/background-session-relocation.js";

const session: Session = {
  id: "session-1",
  project_id: "project-1",
  name: "Codex",
  kind: "Agent",
  lifecycle_state: "running",
  runtime_epoch: 1,
  archived_at_epoch_ms: null,
  resume_failure_reason: null,
  retryable: false,
  closable: false,
  forkable: true,
  ask_to_source_session_id: null,
  run_configuration_id: null,
  process: {
    program: "codex",
    args: [],
    cwd: "/repo",
    agent_id: "codex",
    template_ref: "builtin.agent.interactive",
    template_version: 1,
  },
};

const task: Task = {
  id: "task-1",
  project_id: "project-1",
  title: "Repair flow",
  brief: null,
  jira_url: null,
  archived_at_epoch_ms: null,
  status: "open",
  branch: { repository_root: "/repo", name: "feature/repair-flow" },
  worktree: { path: "/repo-repair-flow" },
  worktree_generation: 1,
  rank: 0,
  created_at_epoch_ms: 1,
  updated_at_epoch_ms: 1,
};

const preview: SessionRelocationPreviewDto = {
  session,
  task,
  source_cwd: "/repo",
  target_cwd: "/repo-repair-flow",
  agent_id: "codex",
  model: "default",
  permission: "default",
  reasoning: "default",
  mode: "resume",
  target_agent_count: 0,
  target_terminal_count: 0,
  warnings: [],
  blockers: [],
  can_relocate: true,
  relocation_ticket: "a".repeat(64),
  expires_in_ms: 30_000,
  manifest: { digest: "sha256:relocation" } as InspectableLaunchManifest,
};

describe("Session worktree relocation repair routing", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("opens the explicit Repair flow when a worktree move returns damaged history", async () => {
    const close = vi.fn();
    const repairProviderHistory = vi.fn();
    const relocate = vi.fn(async () => true);
    await act(async () => {
      root.render(createElement(SessionRelocationDialog, {
        session,
        tasks: [task],
        initialTaskId: task.id,
        close,
        preview: vi.fn(async () => preview),
        relocate,
        repairProviderHistory,
        provision: vi.fn(),
      }));
    });
    await act(async () => undefined);

    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Yes");
    expect(submit).toBeDefined();
    await act(async () => submit?.click());

    expect(relocate).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(repairProviderHistory).toHaveBeenCalledOnce();
  });

  it("keeps the dialog dismissible without replacing its approved preview while moving", async () => {
    let finishMove: ((requiresRepair: boolean) => void) | undefined;
    const relocate = vi.fn(() => new Promise<boolean>((resolve) => { finishMove = resolve; }));
    const initialPreview = vi.fn(async () => preview);
    const invalidatedPreview = vi.fn(async () => ({
      ...preview,
      blockers: ["sourceNotRunning" as const],
      can_relocate: false,
      relocation_ticket: null,
      manifest: null,
    }));
    const close = vi.fn();
    const props = {
      session,
      tasks: [task],
      initialTaskId: task.id,
      close,
      relocate,
      repairProviderHistory: vi.fn(),
      provision: vi.fn(),
    };

    await act(async () => {
      root.render(createElement(SessionRelocationDialog, {
        ...props,
        preview: initialPreview,
      }));
    });
    await act(async () => undefined);

    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Yes");
    await act(async () => submit?.click());

    const hide = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Hide");
    expect(hide?.disabled).toBe(false);
    expect(host.textContent).toContain("The move continues in the background");

    await act(async () => {
      root.render(createElement(SessionRelocationDialog, {
        ...props,
        preview: invalidatedPreview,
      }));
    });

    expect(invalidatedPreview).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("The source Agent is no longer running");
    await act(async () => hide?.click());
    expect(close).toHaveBeenCalledOnce();

    await act(async () => finishMove?.(false));
  });

  it("keeps the relocation failure visible instead of replacing it with sourceNotRunning", async () => {
    const previewRelocation = vi.fn(async () => preview);
    const relocationFailure = "The move timed out again after one automatic retry.";

    await act(async () => {
      root.render(createElement(SessionRelocationDialog, {
        session,
        tasks: [task],
        initialTaskId: task.id,
        close: vi.fn(),
        preview: previewRelocation,
        relocate: vi.fn(async () => { throw new Error(relocationFailure); }),
        repairProviderHistory: vi.fn(),
        provision: vi.fn(),
      }));
    });
    await act(async () => undefined);

    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Yes");
    await act(async () => submit?.click());

    expect(previewRelocation).toHaveBeenCalledOnce();
    expect(host.textContent).toContain(relocationFailure);
    expect(host.textContent).not.toContain("The source Agent is no longer running");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Close")?.disabled).toBe(false);
  });

  it("creates a Task and its worktree inline, then relocates when the worktree is ready", async () => {
    const createdTask: Task = {
      ...task,
      id: "task-new",
      title: "Inline relocation",
      branch: null,
      worktree: null,
    };
    const readyTask: Task = {
      ...createdTask,
      branch: { repository_root: "/repo", name: "task/inline-relocation" },
      worktree: { path: "/repo-inline-relocation" },
      worktree_health: { launch_ready: true } as never,
    };
    const createTask = vi.fn(async () => ({ taskId: createdTask.id }));
    const provision = vi.fn();
    const listBranches = vi.fn(async () => ({
      repository_root: "/repo",
      branches: [{ name: "main", exact_ref: "refs/heads/main" }],
      base_branches: [
        { name: "origin/main", exact_ref: "refs/remotes/origin/main" },
        { name: "origin/development", exact_ref: "refs/remotes/origin/development" },
      ],
      base_branches_truncated: false,
      truncated: false,
    }));
    const beginProvisioning = vi.fn();
    const relocate = vi.fn(async () => false);
    const previewRelocation = vi.fn(async () => ({
      ...preview,
      task: readyTask,
      target_cwd: readyTask.worktree!.path,
    }));
    const props = {
      session,
      initialTaskId: undefined,
      close: vi.fn(),
      preview: previewRelocation,
      relocate,
      repairProviderHistory: vi.fn(),
      taskCreation: {
        projectId: "project-1",
        repositoryPath: "/repo",
        createTask,
        listBranches,
        beginProvisioning,
      },
      provision,
    };

    await act(async () => {
      root.render(createElement(SessionRelocationDialog, { ...props, tasks: [] }));
    });
    const taskSelect = host.querySelector<HTMLSelectElement>("#relocation-task")!;
    await act(async () => {
      taskSelect.value = "__new_task__";
      taskSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => undefined);
    const baseBranch = host.querySelector<HTMLSelectElement>("#relocation-new-task-base-ref")!;
    expect(baseBranch.value).toBe("refs/remotes/origin/development");
    await act(async () => {
      baseBranch.value = "refs/remotes/origin/main";
      baseBranch.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const titleInput = host.querySelector<HTMLInputElement>("#relocation-new-task-title")!;
    await act(async () => typeInto(titleInput, "Inline relocation"));
    const create = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create & continue")!;
    await act(async () => create.click());

    expect(createTask).toHaveBeenCalledWith("Inline relocation", null);
    expect(beginProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: createdTask.id,
        repositoryPath: "/repo",
        destinationPath: "/task-inline-relocation_worktree",
        branchName: "task/inline-relocation",
        branchMode: "create",
        baseRef: "refs/remotes/origin/main",
      }),
      "resume",
    );
    expect(props.close).toHaveBeenCalledOnce();
    expect(provision).not.toHaveBeenCalled();
    expect(relocate).not.toHaveBeenCalled();

    const intent: BackgroundSessionRelocationIntent = {
      sessionId: session.id,
      taskId: readyTask.id,
      mode: "resume",
      provisioning: false,
    };
    const finish = vi.fn();
    const reopen = vi.fn();
    await act(async () => {
      root.render(createElement(BackgroundSessionRelocation, {
        intents: [intent],
        tasks: [readyTask],
        preview: previewRelocation,
        relocate,
        finish,
        reopen,
        repairProviderHistory: vi.fn(),
      }));
    });
    await act(async () => undefined);

    expect(previewRelocation).toHaveBeenCalledWith(session.id, readyTask.id, "resume");
    expect(relocate).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(readyTask.id);
    expect(reopen).not.toHaveBeenCalled();
  });
});

function typeInto(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
