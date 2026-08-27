// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus, BranchCommitSummary, GitHostProjection, RunConfiguration, RunRuntime, Session, Task } from "../src/renderer/model.js";
import { TaskRail, askToHelpersForSources, taskAttachedSessionIds, taskRelocationDropEnabled, type TaskRailProps } from "../src/renderer/ui/TaskRail.js";
import { readTaskCollapsed, writeTaskCollapsed } from "../src/renderer/task-collapse-memory.js";
import type { TaskProvisionWorktreeParams } from "@termloop/contract/current";
import { fullAgentCapability, launchOnlyGeminiCapability } from "./agent-capability-fixture.js";

beforeEach(() => window.localStorage.clear());

function launchableTask(): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Compact launchers",
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: null,
    status: "open",
    branch: { repository_root: "/repository", name: "feature/launchers" },
    worktree: { path: "/repository/.worktrees/launchers" },
    worktree_generation: 1,
    worktree_health: {
      observation_sequence: 1,
      observed_at_epoch_ms: 1,
      path_state: "present",
      registration_state: "matching",
      head_state: "matching",
      launch_ready: true,
      checked_out_branch: "feature/launchers",
      change_count: 0,
      tracked_state: "clean",
      staged_state: "clean",
      untracked_state: "absent",
      ignored_state: "absent",
      submodule_state: "absent",
      worktree_lock_state: "absent",
      index_lock_state: "absent",
      upstream_state: "inSync",
      summary: "healthy",
    },
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
  };
}

/// `exactOptionalPropertyTypes` forbids setting the optional worktree fields to
/// undefined, so an unprovisioned Task omits them entirely.
function worktreeLessTask(): Task {
  const { worktree_generation: _generation, worktree_health: _health, ...rest } = launchableTask();
  return { ...rest, worktree: null };
}

function mergedProjection(task: Task): GitHostProjection {
  return {
    task_id: task.id,
    branch_name: task.branch?.name ?? null,
    repository_provider: "github",
    repository_host: "github.com",
    repository_owner: "termloop",
    repository_project: null,
    repository_name: "termloop-next",
    quality: "matches",
    freshness: "fresh",
    reason: null,
    matches: [{
      provider: "github",
      host: "github.com",
      repository_owner: "termloop",
      repository_project: null,
      repository_name: "termloop-next",
      number: 42,
      title: "Ship compact launchers",
      url: "https://github.com/termloop/termloop-next/pull/42",
      state: "merged",
      base_branch: "main",
      head_branch: "feature/launchers",
      head_repository_owner: "termloop",
      head_repository_project: null,
      head_repository_name: "termloop-next",
      checks: "passing",
      review: "approved",
      mergeability: "unknown",
      updated_at_epoch_ms: 1,
    }],
    truncated: false,
    candidate_truncated: false,
    freshness_generation: 1,
    last_success_observed_at_epoch_ms: 1,
    last_attempt_observed_at_epoch_ms: 1,
  };
}

function agentSession(id: string): Session {
  return {
    id,
    project_id: "project-1",
    name: id,
    kind: "Agent",
    process: {
      program: "codex",
      args: [],
      cwd: "/repository/.worktrees/launchers",
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: 1,
    },
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    retryable: false,
    closable: false,
    forkable: false,
    resume_failure_reason: null,
  };
}

function runConfiguration(): RunConfiguration {
  return {
    id: "run-dev",
    projectId: "project-1",
    name: "Web dev server",
    kind: "devServer",
    command: "pnpm dev",
    workingDirectory: ".",
    env: [],
    setupCommand: "pnpm install",
    setupPolicy: "oncePerWorktree",
    urlAutoDetect: true,
    fallbackUrls: ["http://localhost:5173"],
    autoOpenFirstUrl: true,
    generation: 1,
    updatedAtEpochMs: 1,
  };
}

function runSession(lifecycleState: Session["lifecycle_state"] = "running"): Session {
  return {
    ...agentSession("run-session"),
    name: "Web dev server",
    kind: "Terminal",
    lifecycle_state: lifecycleState,
    run_configuration_id: "run-dev",
    process: {
      program: "/bin/zsh",
      args: ["-lc", "pnpm dev"],
      cwd: "/repository/.worktrees/launchers",
      agent_id: null,
      template_ref: null,
      template_version: null,
    },
  };
}

function runRuntime(exitCode: number | null = null): RunRuntime {
  return {
    sessionId: "run-session",
    taskId: "task-1",
    configurationId: "run-dev",
    urls: ["http://localhost:5173"],
    exitCode,
  };
}

function agentStatus(sessionId: string, status: AgentStatus["status"]): AgentStatus {
  return { sessionId, status, source: "appServer", observedAtEpochMs: 1 };
}

type RailOptions = { task?: Task; tasks?: readonly Task[]; gitHostProjection?: GitHostProjection; branchCommitSummary?: BranchCommitSummary; runConfigurations?: readonly RunConfiguration[]; runRuntimes?: readonly RunRuntime[]; sessions?: readonly Session[]; agentGroups?: readonly import("../src/layout/model.js").AgentGroupLayout[]; statuses?: readonly AgentStatus[]; reviewReadySessionIds?: ReadonlySet<string>; selectedSessionId?: string; deleting?: boolean; archivedTaskCount?: number; nowEpochMs?: number; openTaskChanges?: TaskRailProps["openTaskChanges"]; openTaskDetail?(taskId: string): void; detailTaskId?: string };

function railProps(options: RailOptions = {}): TaskRailProps {
  const unused = async (): Promise<never> => { throw new Error("unused test callback"); };
  const task = options.task ?? launchableTask();
  return {
    projectId: "project-1",
    projectFolder: "/repository",
    tasks: options.tasks ?? [task],
    gitHostProjections: options.gitHostProjection ? [options.gitHostProjection] : [],
    branchCommitSummaries: options.branchCommitSummary ? [options.branchCommitSummary] : [],
    runConfigurations: options.runConfigurations ?? [],
    runRuntimes: options.runRuntimes ?? [],
    runStateRevision: 0,
    runImprovement: { start: unused, versions: unused, restore: unused },
    setupRunImprovement: () => {},
    sessionsById: new Map((options.sessions ?? []).map((session) => [session.id, session])),
    agentGroups: options.agentGroups,
    statusesById: new Map((options.statuses ?? []).map((status) => [status.sessionId, status])),
    reviewReadySessionIds: options.reviewReadySessionIds ?? new Set(),
    selectedSessionId: options.selectedSessionId,
    visibleSessionIds: new Set(),
    menuSessionId: undefined,
    deletingTaskIds: options.deleting ? new Set([task.id]) : new Set(),
    selectSession: () => {},
    openSessionMenu: () => {},
    dismissSession: () => {},
    resumeSession: () => {},
    disabled: false,
    createTask: unused,
    updateTask: unused,
    bindTaskBranch: unused,
    listProjectLocalBranches: unused,
    provisionTaskWorktree: unused,
    dismissTaskWorktreeProvisioning: unused,
    inspectTaskWorktreeCleanup: unused,
    cleanupTaskWorktree: unused,
    openTaskChanges: options.openTaskChanges ?? (() => {}),
    openTaskDetail: options.openTaskDetail ?? (() => {}),
    detailTaskId: options.detailTaskId,
    agentCapabilities: [
      fullAgentCapability("claude", { version: null }),
      fullAgentCapability("codex", { version: null }),
      launchOnlyGeminiCapability(),
    ],
    launchTaskTerminal: unused,
    launchTaskAgent: unused,
    saveRunConfiguration: unused,
    deleteRunConfiguration: unused,
    launchTaskRun: unused,
    inspectTaskWorktreeRepair: unused,
    repairTaskWorktree: unused,
    dismissTaskWorktreeRepair: unused,
    setTaskClosed: async () => {},
    inspectTaskArchive: unused,
    archiveTask: unused,
    archivedTaskCount: options.archivedTaskCount ?? 0,
    archivedTasksChanged: () => {},
    deleteTaskAndWorktree: unused,
    openExternal: async () => {},
    overlayVisibilityChanged: () => {},
    overlayContainer: undefined,
    nowEpochMs: options.nowEpochMs ?? 100,
  };
}

function renderRail(options: RailOptions = {}): string {
  return renderToStaticMarkup(createElement(TaskRail, railProps(options)));
}

async function renderRailTab(options: RailOptions, tab: "active" | "closed"): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(TaskRail, railProps(options))));
  if (tab === "closed") {
    await act(async () => container.querySelector<HTMLButtonElement>('[data-task-list-tab="closed"]')!.click());
  }
  const markup = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  return markup;
}

describe("Task rail native overlay", () => {
  it("keeps the Task menu and Archive dialog above Ghostty in the overlay window", async () => {
    const container = document.createElement("div");
    const overlayContainer = document.createElement("div");
    document.body.append(container);
    document.body.append(overlayContainer);
    const root = createRoot(container);
    const overlayVisibilityChanged = vi.fn();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, {
      ...railProps(),
      inspectTaskArchive: () => new Promise<Awaited<ReturnType<TaskRailProps["inspectTaskArchive"]>>>(() => {}),
      overlayVisibilityChanged,
      overlayContainer,
    })));

    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='More actions for Compact launchers']")?.click());
    expect(container.querySelector(".task-context-menu")).toBeNull();
    expect(overlayContainer.querySelector(".task-context-menu")).not.toBeNull();
    expect(overlayVisibilityChanged).toHaveBeenLastCalledWith(true);

    const archive = [...overlayContainer.querySelectorAll<HTMLButtonElement>("button[role='menuitem']")]
      .find((button) => button.textContent?.includes("Archive Task"));
    await act(async () => archive?.click());
    expect(container.querySelector("[aria-labelledby='archive-task-title']")).toBeNull();
    expect(overlayContainer.querySelector("[aria-labelledby='archive-task-title']")).not.toBeNull();
    expect(overlayVisibilityChanged).toHaveBeenLastCalledWith(true);

    await act(async () => overlayContainer.querySelector<HTMLButtonElement>(".dialog-backdrop")?.click());
    expect(overlayVisibilityChanged).toHaveBeenLastCalledWith(false);
    await act(async () => root.unmount());
    container.remove();
    overlayContainer.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});

describe("Task rail agent attention", () => {
  it("orders live Agents like All Active Agents while keeping non-Agent slots stable", () => {
    const olderIdle = agentSession("older-idle");
    const terminal = { ...agentSession("terminal"), kind: "Terminal" as const };
    const working = agentSession("working");
    const review = agentSession("review");
    const recentIdle = agentSession("recent-idle");
    const interrupted = agentSession("interrupted");
    const waiting = agentSession("waiting");
    const sessions = [olderIdle, terminal, working, review, recentIdle, interrupted, waiting];
    const statuses = [
      { ...agentStatus(olderIdle.id, "idle"), observedAtEpochMs: 10 },
      agentStatus(working.id, "working"),
      agentStatus(review.id, "idle"),
      { ...agentStatus(recentIdle.id, "idle"), observedAtEpochMs: 20 },
      agentStatus(interrupted.id, "interrupted"),
      agentStatus(waiting.id, "awaitingInput"),
    ];
    const markup = renderRail({ sessions, statuses, reviewReadySessionIds: new Set([review.id]) });

    expect([...markup.matchAll(/data-session-id="([^"]+)"/gu)].map((match) => match[1]))
      .toEqual([waiting.id, terminal.id, review.id, interrupted.id, working.id, recentIdle.id, olderIdle.id]);
  });

  it("orders older Task Agent groups last without an age divider row", () => {
    const nowEpochMs = 1_000_000;
    const olderIdle = agentSession("older-idle");
    const recentWorking = agentSession("recent-working");
    const markup = renderRail({
      sessions: [olderIdle, recentWorking],
      statuses: [
        { ...agentStatus(olderIdle.id, "idle"), observedAtEpochMs: nowEpochMs - 600_001 },
        { ...agentStatus(recentWorking.id, "working"), observedAtEpochMs: nowEpochMs - 600_000 },
      ],
      nowEpochMs,
    });

    expect(markup.indexOf('data-session-id="recent-working"'))
      .toBeLessThan(markup.indexOf('data-session-id="older-idle"'));
    /// The "10m+ ago" separator belongs to All Active Agents. Inside a Task the
    /// agents already read from the row's own dots, so the rail never rents
    /// that vocabulary back.
    expect(markup).not.toContain("active-agent-age-divider");
    expect(markup).not.toContain("10m+ ago");
  });

  it("uses durable plan activity to order same-state Task Agents after restart", () => {
    const older = agentSession("older-working");
    const recent = agentSession("recent-working");
    const plannedStatus = (session: Session, updatedAtEpochMs: number): AgentStatus => ({
      ...agentStatus(session.id, "working"),
      observedAtEpochMs: 0,
      plan: {
        source: "codexAppServer",
        explanation: null,
        steps: [],
        updatedAtEpochMs,
      },
    });
    const markup = renderRail({
      sessions: [older, recent],
      statuses: [plannedStatus(older, 100), plannedStatus(recent, 200)],
    });

    expect(markup.indexOf('data-session-id="recent-working"'))
      .toBeLessThan(markup.indexOf('data-session-id="older-working"'));
  });

  it("renders peer Agent groups inside their Task without changing Task attachment", () => {
    const first = agentSession("group-first");
    const second = agentSession("group-second");
    const markup = renderRail({
      sessions: [first, second],
      statuses: [agentStatus(first.id, "working"), agentStatus(second.id, "idle")],
      agentGroups: [{ sessionIds: [first.id, second.id], name: "Task crew" }],
    });

    expect(markup).toContain('aria-label="Task crew, Agent group with 2 agents"');
    expect(markup).toContain('data-agent-group="manual"');
    expect(markup).toContain('>Task crew</button>');
    expect(markup).toContain('data-session-drop-target="group-first"');
    expect(markup).toContain('data-session-drop-target="group-second"');
    expect(markup.indexOf('data-session-id="group-first"')).toBeLessThan(markup.indexOf('data-session-id="group-second"'));
  });

  it("exposes the whole open Task group as one Session relocation drop target", () => {
    expect(renderRail()).toContain('data-session-drop-target="task-1"');
    expect(renderRail({ task: { ...launchableTask(), status: "closed" } }))
      .not.toContain("data-session-drop-target");
  });

  it("never offers a Session's own Task as a relocation drop target", () => {
    const task = launchableTask();
    const attached = agentSession("attached-agent");
    const loose = agentSession("loose-agent");
    loose.process = { ...loose.process, cwd: "/repository" };
    const sessionsById = new Map([[attached.id, attached], [loose.id, loose]]);
    expect(taskRelocationDropEnabled(task, sessionsById, false, attached)).toBe(false);
    expect(taskRelocationDropEnabled(task, sessionsById, false, loose)).toBe(true);
    expect(taskRelocationDropEnabled(task, sessionsById, false, undefined)).toBe(false);
    expect(taskRelocationDropEnabled({ ...task, status: "closed" }, sessionsById, false, loose)).toBe(false);
    expect(taskRelocationDropEnabled(task, sessionsById, true, loose)).toBe(false);
  });

  it("makes an ordinary Task Agent draggable toward Active Agents", () => {
    const session = agentSession("move-out-agent");
    const markup = renderRail({ sessions: [session] });
    expect(markup).toContain('aria-label="Move move-out-agent"');
    expect(markup).toContain('class="session-row task-session with-drag-handle"');
    expect(markup).toContain("session-drag-handle");
    expect(markup).toContain('data-session-id="move-out-agent"');
    expect(markup.match(/aria-roledescription="draggable"/gu)).toHaveLength(2);
  });

  it("keeps agent detail out of a collapsed Task and on its expanded Session row", () => {
    const working = agentSession("working-agent");
    const collapsedTask = { ...launchableTask(), status: "closed" as const };
    const collapsed = renderRail({
      task: collapsedTask,
      sessions: [working],
      statuses: [agentStatus(working.id, "working")],
    });
    const expanded = renderRail({
      sessions: [working],
      statuses: [agentStatus(working.id, "working")],
    });

    expect(collapsed).not.toContain("row-rail");
    expect(collapsed).not.toContain("task-agent-summary");
    expect(expanded).toContain('class="row-rail working"');
    expect(expanded).toContain("task-children");
  });

  it("nests the current structured Agent plan under its Session", () => {
    const working = agentSession("planning-agent");
    const status: AgentStatus = {
      ...agentStatus(working.id, "working"),
      plan: {
        source: "codexAppServer",
        explanation: "Keep the rollout exact.",
        steps: [
          { text: "Inspect the flow", status: "completed" },
          { text: "Render the current plan", status: "inProgress" },
          { text: "Run focused tests", status: "pending" },
        ],
        updatedAtEpochMs: 2,
      },
    };
    const markup = renderRail({ sessions: [working], statuses: [status] });

    expect(markup).toContain('class="agent-plan"');
    expect(markup).toContain('<span class="agent-plan-count">1/3</span>');
    expect(markup).toContain('title="Render the current plan"');
    expect(markup).toContain('data-status="completed"');
    expect(markup).toContain("Keep the rollout exact.");
    /// The completed count is visible at a glance without a competing progress bar.
    expect(markup).not.toContain("agent-plan-bar");

    const done: AgentStatus = {
      ...status,
      plan: { ...status.plan!, steps: status.plan!.steps.map((step) => ({ ...step, status: "completed" as const })) },
    };
    expect(renderRail({ sessions: [working], statuses: [done] })).not.toContain("agent-plan");
    expect(renderRail({ sessions: [working], statuses: [done], selectedSessionId: working.id })).toContain('class="agent-plan done"');
  });

  it("drops the plan the moment its Session is no longer live", () => {
    const stopped: Session = { ...agentSession("stopped-agent"), lifecycle_state: "resumeFailed", closable: true };
    const status: AgentStatus = {
      ...agentStatus(stopped.id, "working"),
      plan: {
        source: "codexAppServer",
        explanation: null,
        steps: [{ text: "Never shown", status: "pending" }],
        updatedAtEpochMs: 2,
      },
    };
    expect(renderRail({ sessions: [stopped], statuses: [status] })).not.toContain("agent-plan");
  });
});

describe("Task rail row anatomy", () => {
  it("offers an idle run as a launcher chip in the Task's Start row, not a card", () => {
    const markup = renderRail({ runConfigurations: [runConfiguration()] });
    expect(markup).toContain('class="run-chip"');
    expect(markup).toContain("Web dev server");
    expect(markup).toContain("Run Web dev server in Compact launchers");
    // The command belongs to the chip's tooltip, and the run never draws a
    // second status block beside the Session that represents it.
    expect(markup).toContain("Dev server · pnpm dev");
    expect(markup).not.toContain("run-profile-card");
    expect(markup).not.toContain(">Setup + run</button>");
  });

  it("leaves the Start row to real launchers: no bare add icon in any Task", () => {
    expect(renderRail()).not.toContain("run-chip");
    // Every chip in the row is a run button, so nothing here only opens a form.
    expect(renderRail({ runConfigurations: [runConfiguration()] })).not.toContain("Add a run configuration");
    // The Start row itself stays: terminals and agents are still launchable.
    expect(renderRail()).toContain('class="task-launch"');
  });

  it("represents a live run by its Session row plus URLs and restart, never a second chip", () => {
    const markup = renderRail({
      runConfigurations: [runConfiguration()],
      runRuntimes: [runRuntime()],
      sessions: [runSession()],
    });

    expect(markup).not.toContain("run-chip-start");
    expect(markup).toContain('class="run-line"');
    expect(markup).toContain("localhost:5173");
    expect(markup).toContain("Open http://localhost:5173 in the browser");
    expect(markup).toContain("Restart this run");
    // Stopping the process is reachable from the run's own controls, not only
    // from the Session row's close.
    expect(markup).toContain("Stop this run");
    expect(markup).toContain('class="run-controls"');
    // A run Session reads as a service, not as an Agent terminal: its own badge
    // instead of a presence dot, a named category, and the command it runs in
    // place of the shell and the folder.
    expect(markup).toContain("session-item terminal run");
    expect(markup).toContain('class="run-badge"');
    expect(markup).toContain('class="row-run-kind"');
    expect(markup).toContain('class="row-run-command"');
    expect(markup).toContain(">pnpm dev</code>");
    expect(markup).not.toContain(">zsh</span>");
    expect(markup).not.toContain('class="live-dot"');
  });

  it("states a failing exit code under the run Session that produced it", () => {
    const markup = renderRail({
      runConfigurations: [runConfiguration()],
      runRuntimes: [runRuntime(143)],
      sessions: [runSession("exited")],
    });

    expect(markup).toContain("exit 143");
    // Nothing to open or restart once the process is gone.
    expect(markup).not.toContain("localhost:5173");
    expect(markup).not.toContain("Restart this run");
    // The launcher comes back, because starting it again is now the only action.
    expect(markup).toContain("Run Web dev server in Compact launchers");
  });

  it("does not resurrect a run line after its Session was explicitly closed", () => {
    const markup = renderRail({
      runConfigurations: [runConfiguration()],
      runRuntimes: [runRuntime(143)],
    });

    expect(markup).not.toContain('class="run-line"');
    expect(markup).not.toContain("exit 143");
    expect(markup).not.toContain("localhost:5173");
    expect(markup).toContain('class="run-chip"');
  });

  it("renders the issue key as a real action and keeps the full worktree path reachable", () => {
    const markup = renderRail({
      task: {
        ...launchableTask(),
        jira_url: "https://example.atlassian.net/browse/UKIE-697",
        worktree: {
          path: "/Users/example/Projects/termloop-ukie-697-automation-expired-list-for-season-ticket-worktree",
        },
      },
    });
    expect(markup).toContain('class="task-signal issue"');
    expect(markup).toContain("Open Jira UKIE-697 in browser");
    expect(markup).toContain(">UKIE-697</button>");
    /// The folder no longer spends meta-line width; the full path rides the
    /// branch token's tooltip instead.
    expect(markup).not.toContain("task-leaf");
    expect(markup).toContain("Worktree /Users/example/Projects/termloop-ukie-697-automation-expired-list-for-season-ticket-worktree");

    /// A title that already carries the issue key makes the meta-line key pure
    /// repetition, so it steps aside; other titles keep the click affordance.
    const titled = renderRail({
      task: {
        ...launchableTask(),
        title: "UKIE-697: Expired list automation",
        jira_url: "https://example.atlassian.net/browse/UKIE-697",
      },
    });
    expect(titled).not.toContain('class="task-signal issue"');
  });

  it("labels the launcher group instead of leaving three bare glyphs", () => {
    const markup = renderRail();
    expect(markup).toContain('class="task-launch" role="group" aria-label="Start a new Session in Compact launchers"');
    expect(markup).toContain('class="task-launch-label" aria-hidden="true">Start<');
    expect(markup).toContain('class="task-launch-icon" title="New Terminal"');
    expect(markup).toContain('class="task-launch-icon agent-claude" title="New Claude Session"');
    expect(markup).toContain('class="task-launch-icon agent-codex" title="New Codex Session"');
    expect(markup).toContain('class="task-launch-icon agent-gemini" title="New Gemini CLI Session (launch only)"');
  });

  it("keeps a background deletion visible and disables Task actions", () => {
    const markup = renderRail({ deleting: true });
    expect(markup).toContain("Deleting");
    expect(markup).toContain('class="task-row deleting"');
    expect(markup).toContain('class="task-pulse"');
    expect(markup).toContain('class="task-item open" disabled=""');
    expect(markup).toContain('class="task-meta-flag busy"');
    expect(markup).not.toContain("task-launch");
    /// The meta line survives only to carry "Deleting"; every action, agent
    /// dot, and fact about to disappear is withheld.
    expect(markup).toContain('class="task-meta"');
    expect(markup).not.toContain("task-meta-branch");
    expect(markup).not.toContain("task-next-step");
    expect(markup).not.toContain("task-signal");
    expect(markup).not.toContain("task-agents");
  });

  it("keeps one uniform row anatomy and folds only the children while collapsed", async () => {
    const task: Task = {
      ...launchableTask(),
      brief: "Secondary Task context",
      archived_at_epoch_ms: null,
      status: "closed",
      worktree_health: { ...launchableTask().worktree_health!, change_count: 3, tracked_state: "changed" },
    };
    const branchCommitSummary: BranchCommitSummary = {
      task_id: task.id,
      count: 5,
      base_ref: "refs/heads/main",
      not_in_base: { count: 5, base_ref: "refs/heads/main", freshness: "fresh", reason: null },
      freshness: "fresh",
      reason: null,
    };
    const collapsed = await renderRailTab({ task, branchCommitSummary }, "closed");
    expect(collapsed).toContain('aria-label="Expand Compact launchers"');
    // The row is the way onto the Task's page; its name carries the whole row.
    expect(collapsed).toContain('aria-label="Open Compact launchers, closed');
    expect(collapsed).toContain('<strong class="task-title">Compact launchers</strong>');
    // The single-line title and the brief stay recoverable from the row tooltip
    // rather than spending a second line.
    expect(collapsed).toContain('title="Compact launchers — Secondary Task context"');
    expect(collapsed).not.toContain("task-brief");
    expect(collapsed).not.toContain("task-note");
    expect(collapsed).not.toContain("task-identity");
    expect(collapsed).not.toContain("row-rail");
    // The dot and meta line are the fixed anatomy, so they survive collapsing;
    // only the children fold away. A closed Task keeps its identity but stops
    // asking for anything — no signals on parked work.
    expect(collapsed).toContain('class="task-dot quiet"');
    expect(collapsed).toContain('class="task-meta"');
    expect(collapsed).toContain('class="task-meta-branch"');
    expect(collapsed).not.toContain("3 changes");
    expect(collapsed).not.toContain("5 unmerged");
    expect(collapsed).not.toContain("task-children");

    const expanded = renderRail({ task: { ...task, status: "open" }, branchCommitSummary });
    expect(expanded).toContain("task-children");
    expect(expanded).toContain('class="task-meta"');
    expect(expanded).toContain(">3 changes</button>");
    expect(expanded).toContain(">5 unmerged</button>");
  });

  it("states an off-nominal stage once and leaves a healthy Task unlabelled", async () => {
    expect(renderRail()).not.toContain('class="task-meta-flag');

    const noWorktree: Task = worktreeLessTask();
    const noWorktreeMarkup = renderRail({ task: noWorktree });
    expect(noWorktreeMarkup).not.toContain('class="task-meta-flag');
    expect(noWorktreeMarkup).toContain('class="task-next-step optional"');
    expect(noWorktreeMarkup).toContain("Create worktree");

    const closed = await renderRailTab({ task: { ...launchableTask(), status: "closed" } }, "closed");
    expect(closed).not.toContain('class="task-meta-flag');
    expect(closed).toContain('class="task-item closed"');
  });

  it("explains a failed worktree in words and offers the retry as a recovery step", () => {
    const task = {
      ...worktreeLessTask(),
      worktree_provisioning: { status: "failed", operation_id: "op-1", failure: { kind: "pathConflict" } },
    } as unknown as Task;
    const markup = renderRail({ task });
    expect(markup).toContain('class="task-meta-flag blocked"');
    expect(markup).toContain(">Failed</em>");
    expect(markup).toContain("The destination is already in use — or its parent folder does not exist yet.");
    expect(markup).not.toContain("pathConflict");
    expect(markup).toContain('class="task-next-step recovery"');
    expect(markup).toContain("Retry worktree");
  });

  it("warns when the checkout sits on another branch than the Task branch", () => {
    const task: Task = {
      ...launchableTask(),
      worktree_health: { ...launchableTask().worktree_health!, checked_out_branch: "main" },
    };
    const markup = renderRail({ task });
    expect(markup).toContain('class="task-signal attention"');
    expect(markup).toContain(">on main</small>");
    expect(markup).toContain("not the Task branch feature/launchers");
    /// The divergence signal replaces the branch token rather than joining it:
    /// the checked-out branch is the operative fact, and the Task branch it
    /// displaced stays in the signal's tooltip.
    expect(markup).not.toContain('class="task-meta-branch"');
  });

  it("renders no-remote PR state quietly and omits the attached Session count", () => {
    const task: Task = {
      ...launchableTask(),
      worktree_presence: {
        observation_sequence: 1,
        observed_at_epoch_ms: 1,
        attached_sessions: [{ session_id: "session-1", kind: "Agent" }],
        total_count: 1,
        terminal_count: 0,
        agent_count: 1,
        truncated: false,
      },
    };
    const projection: GitHostProjection = {
      task_id: task.id,
      branch_name: task.branch?.name ?? null,
      repository_provider: null,
      repository_host: null,
      repository_owner: null,
      repository_project: null,
      repository_name: null,
      quality: "unavailable",
      freshness: "unavailable",
      reason: "noRemote",
      matches: [],
      truncated: false,
      candidate_truncated: false,
      freshness_generation: 1,
      last_success_observed_at_epoch_ms: null,
      last_attempt_observed_at_epoch_ms: 1,
    };

    const markup = renderRail({ task, gitHostProjection: projection });
    expect(markup).toContain('class="task-signal quiet"');
    expect(markup).toContain("Merge unknown</small>");
    expect(markup).not.toContain("1 attached");
    expect(markup).not.toContain('data-testid="task-worktree-presence"');
  });

  it("renders every PR returned for Task and worktree branches", () => {
    const task = launchableTask();
    const first = mergedProjection(task).matches[0]!;
    const projection: GitHostProjection = {
      ...mergedProjection(task),
      matches: [
        { ...first, provider: "azureDevOps", host: "dev.azure.com", repository_owner: "valuespaces", repository_project: "Nucleus", repository_name: "Nucleus", number: 13707, title: "Current worktree branch", url: "https://dev.azure.com/valuespaces/Nucleus/_git/Nucleus/pullrequest/13707", head_branch: "UKIE-804", base_branch: "development", head_repository_owner: "valuespaces", head_repository_project: "Nucleus", head_repository_name: "Nucleus", state: "open" },
        { ...first, provider: "azureDevOps", host: "dev.azure.com", repository_owner: "valuespaces", repository_project: "Nucleus", repository_name: "Nucleus", number: 13706, title: "Historical worktree branch", url: "https://dev.azure.com/valuespaces/Nucleus/_git/Nucleus/pullrequest/13706", head_branch: "UKIE-803", base_branch: "master", head_repository_owner: "valuespaces", head_repository_project: "Nucleus", head_repository_name: "Nucleus", state: "merged" },
      ],
    };

    const markup = renderRail({ task, gitHostProjection: projection });
    expect(markup).toContain(">#13707</span>");
    expect(markup).toContain("→ development</span>");
    expect(markup).toContain(">#13706</span>");
    expect(markup).toContain("→ master</span>");
    expect(markup).toContain(">open</span>");
    expect(markup).toContain(">merged</span>");
    expect(markup).toContain(">2 PRs</small>");
    expect(markup).not.toContain(">In base</");
    /// The rail's compact PR row prints number, target, and state on one line.
    /// The head branch and PR title repeat the Task's own branch and title, so
    /// they survive only in the tooltip.
    expect(markup).not.toContain('class="task-pr-head"');
    expect(markup).not.toContain('class="task-pr-title"');
    expect(markup).toContain("UKIE-804 → development · open · Current worktree branch");
    expect(markup).toContain("UKIE-803 → master · merged · Historical worktree branch");
    expect(markup).toContain("Open pull request 13707 in browser");
    expect(markup).toContain("Open pull request 13706 in browser");
  });

  it("separates total branch history from provider merge status", () => {
    const task = launchableTask();
    const branchCommitSummary: BranchCommitSummary = {
      task_id: task.id,
      count: 6,
      base_ref: "refs/remotes/origin/main",
      not_in_base: {
        count: 0,
        base_ref: "refs/remotes/origin/main",
        freshness: "fresh",
        reason: null,
      },
      freshness: "fresh",
      reason: null,
    };

    const markup = renderRail({ task, gitHostProjection: mergedProjection(task), branchCommitSummary });
    expect(markup).toContain('class="task-signal done"');
    expect(markup).toContain(">Merged</button>");
    expect(markup).toContain("Task history: 6 commits.");
    expect(markup).toContain(">6 commits</button>");
    expect(markup).not.toContain(">6 commits total<");
    expect(markup).not.toContain("6 unmerged");
  });

  it("separates total branch history from the current local-base count", () => {
    const task = launchableTask();
    const branchCommitSummary: BranchCommitSummary = {
      task_id: task.id,
      count: 6,
      base_ref: "refs/heads/main",
      not_in_base: {
        count: 4,
        base_ref: "refs/remotes/origin/main",
        freshness: "fresh",
        reason: null,
      },
      freshness: "fresh",
      reason: null,
    };

    const markup = renderRail({ task, branchCommitSummary });
    expect(markup).toContain('class="task-signal attention"');
    expect(markup).toContain(">6 commits</button>");
    expect(markup).toContain(">4 unmerged</button>");
    expect(markup).toContain("Task history: 6 commits.");
  });

  it("does not hide commits added after a provider merge", () => {
    const task = launchableTask();
    const branchCommitSummary: BranchCommitSummary = {
      task_id: task.id,
      count: 6,
      base_ref: "refs/heads/main",
      not_in_base: {
        count: 2,
        base_ref: "refs/heads/main",
        freshness: "fresh",
        reason: null,
      },
      freshness: "fresh",
      reason: null,
    };

    const markup = renderRail({ task, gitHostProjection: mergedProjection(task), branchCommitSummary });
    expect(markup).toContain('class="task-signal attention"');
    expect(markup).toContain(">2 unmerged</button>");
    expect(markup).toContain("provider reports the pull request as merged");
    expect(markup).not.toContain(">Merged</button>");
  });

  it("does not claim everything is merged while local changes remain", () => {
    const task: Task = {
      ...launchableTask(),
      worktree_health: {
        ...launchableTask().worktree_health!,
        change_count: 2,
        tracked_state: "changed",
      },
    };
    const markup = renderRail({ task, gitHostProjection: mergedProjection(task) });
    expect(markup).toContain('class="task-signal attention"');
    expect(markup).toContain(">Merged</button>");
    expect(markup).toContain(">2 changes</button>");
    expect(markup).toContain("local changes remain");
  });

  it("keeps pushed Task branch work visible after the worktree becomes clean", () => {
    const branchCommitSummary: BranchCommitSummary = {
      task_id: "task-1",
      count: 3,
      base_ref: "refs/heads/main",
      not_in_base: {
        count: 3,
        base_ref: "refs/heads/main",
        freshness: "fresh",
        reason: null,
      },
      freshness: "fresh",
      reason: null,
    };

    const markup = renderRail({ branchCommitSummary });

    expect(markup).toContain('aria-label="Review all branch changes in Compact launchers"');
    expect(markup).toContain(">3 commits</button>");
  });

  it("falls back to pushed PR changes when the recorded Task branch is gone", () => {
    const task = launchableTask();
    const branchCommitSummary: BranchCommitSummary = {
      task_id: task.id,
      count: null,
      base_ref: null,
      not_in_base: {
        count: null,
        base_ref: null,
        freshness: "unavailable",
        reason: "branchMissing",
      },
      freshness: "unavailable",
      reason: "branchMissing",
    };

    const markup = renderRail({ task, gitHostProjection: mergedProjection(task), branchCommitSummary });

    expect(markup).toContain('aria-label="Review pushed pull request changes in Compact launchers"');
    expect(markup).toContain(">1 pushed PR</button>");
    expect(markup).not.toContain(">629 commits</button>");
  });

  it("keeps a stopped agent with its exact recorded worktree instead of loose Active Agents", () => {
    const session: Session = {
      id: "session-failed-resume",
      project_id: "project-1",
      name: "Codex recovery",
      kind: "Agent",
      process: {
        program: "codex",
        args: [],
        cwd: "/repository/.worktrees/launchers",
        agent_id: "codex",
        template_ref: "builtin.agent.interactive",
        template_version: 1,
      },
      lifecycle_state: "resumeFailed",
      runtime_epoch: 1,
      archived_at_epoch_ms: null,
      ask_to_source_session_id: null,
      run_configuration_id: null,
      retryable: false,
      closable: true,
      forkable: false,
      resume_failure_reason: "cwdUnavailable",
    };

    const sessions = new Map([[session.id, session]]);
    expect(taskAttachedSessionIds([launchableTask()], sessions)).toEqual(new Set([session.id]));
    expect(renderRail({ sessions: [session] })).toContain("Codex recovery");
  });

  it("offers Retry beside close for a retryable Agent attached to a Task", () => {
    const session: Session = {
      id: "session-retry",
      project_id: "project-1",
      name: "Codex recovery",
      kind: "Agent",
      process: {
        program: "codex",
        args: [],
        cwd: "/repository/.worktrees/launchers",
        agent_id: "codex",
        template_ref: "builtin.agent.interactive",
        template_version: 1,
      },
      lifecycle_state: "resumeFailed",
      runtime_epoch: 1,
      archived_at_epoch_ms: null,
      ask_to_source_session_id: null,
      run_configuration_id: null,
      retryable: true,
      closable: true,
      forkable: false,
      resume_failure_reason: "cwdUnavailable",
    };

    const markup = renderRail({ sessions: [session] });
    const retry = markup.indexOf('aria-label="Retry Codex recovery"');
    const close = markup.indexOf('aria-label="Remove Codex recovery"');
    expect(retry).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(retry);
  });

  it("nests an attached Ask-To helper beneath its caller", () => {
    const session = (id: string, name: string, sourceId: string | null): Session => ({
      id,
      project_id: "project-1",
      name,
      kind: "Agent",
      lifecycle_state: "running",
      runtime_epoch: 1,
      archived_at_epoch_ms: null,
      resume_failure_reason: null,
      retryable: false,
      closable: false,
      forkable: false,
      ask_to_source_session_id: sourceId,
      run_configuration_id: null,
      process: {
        program: "codex",
        args: [],
        cwd: "/repository/.worktrees/launchers",
        agent_id: id.startsWith("helper") ? "claude" : "codex",
        template_ref: id.startsWith("helper") ? "builtin.agent.ask-to-helper" : null,
        template_version: id.startsWith("helper") ? 1 : null,
      },
    });
    const source = session("source-agent", "Source agent", null);
    const helper = session("helper-agent", "Helper agent", source.id);
    const task: Task = {
      ...launchableTask(),
      worktree_presence: {
        observation_sequence: 1,
        observed_at_epoch_ms: 1,
        attached_sessions: [
          { session_id: helper.id, kind: "Agent" },
          { session_id: source.id, kind: "Agent" },
        ],
        total_count: 2,
        terminal_count: 0,
        agent_count: 2,
        truncated: false,
      },
    };

    const markup = renderRail({ task, sessions: [helper, source] });
    expect(markup.indexOf('data-session-id="source-agent"')).toBeLessThan(markup.indexOf('data-session-id="helper-agent"'));
    expect(markup.match(/data-session-id="helper-agent"/gu)).toHaveLength(1);
    expect(markup).toContain('class="ask-to-helper compact"');
    /// The relationship stays in the row's accessible name; the sighted reader
    /// gets it from the elbow nesting alone, without a repeated label line.
    expect(markup).toContain("from Source agent");
    expect(markup).not.toContain('class="ask-to-helper-source"');
    /// A relocatable helper's drag handle claims a grid column; the class that
    /// widens the row template to three columns must ride along or the row
    /// content wraps into a broken stack.
    expect(markup).toContain('aria-label="Move Helper agent"');
    expect(markup).toContain('class="session-row ask-to-helper-row task-session with-drag-handle"');
  });

  it("keeps a helper nested by exact source after only the source cwd moves", () => {
    const source: Session = {
      id: "moved-source",
      project_id: "project-1",
      name: "Moved source",
      kind: "Agent",
      lifecycle_state: "running",
      runtime_epoch: 2,
      archived_at_epoch_ms: null,
      resume_failure_reason: null,
      retryable: false,
      closable: false,
      forkable: false,
      ask_to_source_session_id: null,
      run_configuration_id: null,
      process: {
        program: "codex",
        args: [],
        cwd: "/repository/.worktrees/launchers",
        agent_id: "codex",
        template_ref: "builtin.agent.interactive",
        template_version: 1,
      },
    };
    const helper: Session = {
      ...source,
      id: "old-cwd-helper",
      name: "Old cwd helper",
      ask_to_source_session_id: source.id,
      process: {
        ...source.process,
        cwd: "/repository",
        agent_id: "claude",
        template_ref: "builtin.agent.ask-to-helper",
      },
    };
    const sessions = new Map([[source.id, source], [helper.id, helper]]);
    const attached = taskAttachedSessionIds([launchableTask()], sessions);

    expect(attached).toEqual(new Set([source.id]));
    expect(askToHelpersForSources(attached, sessions)).toEqual(new Set([helper.id]));
    const markup = renderRail({ sessions: [helper, source] });
    expect(markup.match(/data-session-id="old-cwd-helper"/gu)).toHaveLength(1);
    expect(markup).toContain("from Moved source");
  });

  it("keeps a helper independently movable while its own cwd is the Task worktree", () => {
    const source = agentSession("project-source");
    source.process = { ...source.process, cwd: "/repository" };
    const helper = agentSession("worktree-helper");
    helper.ask_to_source_session_id = source.id;
    helper.process = { ...helper.process, template_ref: "builtin.agent.ask-to-helper" };
    const sessions = new Map([[source.id, source], [helper.id, helper]]);

    const attached = taskAttachedSessionIds([launchableTask()], sessions);
    expect(attached).toEqual(new Set([helper.id]));
    expect(askToHelpersForSources(new Set([source.id]), sessions)).toEqual(new Set([helper.id]));
    const markup = renderRail({ sessions: [source, helper] });
    expect(markup).toContain('aria-label="Move worktree-helper"');
  });
});

describe("Task rail first-run UX", () => {
  it("tabs active Tasks individually and keeps closed Tasks in the original combined list", async () => {
    const active = { ...launchableTask(), brief: "Keep the selected Task context visible in the sidebar." };
    const closed = { ...launchableTask(), id: "task-closed", title: "Finished Task", status: "closed" as const };
    const olderClosed = { ...launchableTask(), id: "task-older-closed", title: "Older finished Task", status: "closed" as const };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, railProps({ tasks: [active, closed, olderClosed] }))));

    const activeTab = container.querySelector<HTMLButtonElement>('[role="tab"][data-task-list-tab="active"]')!;
    const closedTab = container.querySelector<HTMLButtonElement>('[role="tab"][data-task-list-tab="closed"]')!;
    expect(activeTab.getAttribute("aria-selected")).toBe("true");
    expect(closedTab.getAttribute("aria-selected")).toBe("false");
    expect(container.querySelector('[data-task-tab-id="task-1"]')).not.toBeNull();
    expect(container.querySelector('.task-list [data-task-id="task-1"]')).not.toBeNull();
    expect(container.querySelector('.task-list [data-task-id="task-closed"]')).toBeNull();
    expect(container.querySelector(".task-group.focused")).not.toBeNull();
    expect(container.querySelector(".task-focus-brief")?.textContent).toContain("selected Task context");
    expect(container.querySelector(".task-focus-facts")?.textContent).toContain("Ready to run agents");

    await act(async () => closedTab.click());
    expect(activeTab.getAttribute("aria-selected")).toBe("false");
    expect(closedTab.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".task-item-tabs")).toBeNull();
    expect(container.querySelector('[data-task-tab-id="task-closed"]')).toBeNull();
    expect(container.querySelector('.task-list [data-task-id="task-1"]')).toBeNull();
    expect(container.querySelector('.task-list [data-task-id="task-closed"]')).not.toBeNull();
    expect(container.querySelector('.task-list [data-task-id="task-older-closed"]')).not.toBeNull();
    expect(container.querySelector(".task-group.focused")).toBeNull();
    expect(container.querySelector(".task-focus-facts")).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows one active Task panel, keeps tab navigation local, and remembers the selection", async () => {
    const first = launchableTask();
    const second = { ...launchableTask(), id: "task-2", title: "Second Task" };
    const openTaskDetail = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const props = railProps({ tasks: [first, second], openTaskDetail });
    await act(async () => root.render(createElement(TaskRail, props)));

    expect(container.querySelectorAll(".task-item-tabs [role=\"tab\"]")).toHaveLength(2);
    expect(container.querySelector('.task-list [data-task-id="task-1"]')).not.toBeNull();
    expect(container.querySelector('.task-list [data-task-id="task-2"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-task-tab-id="task-2"]')!.click());
    expect(container.querySelector('.task-list [data-task-id="task-1"]')).toBeNull();
    expect(container.querySelector('.task-list [data-task-id="task-2"]')).not.toBeNull();
    expect(openTaskDetail).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(TaskRail, props)));
    expect(container.querySelector('[data-task-tab-id="task-2"]')?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('.task-list [data-task-id="task-2"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("creates from the fixed leading button and closes an active Task from its tab", async () => {
    const setTaskClosed = vi.fn(async () => {});
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, {
      ...railProps(),
      setTaskClosed,
    })));

    const create = container.querySelector<HTMLButtonElement>('.task-item-tab-bar > [aria-label="Create Task"]');
    const close = container.querySelector<HTMLButtonElement>('.task-item-tab-close[aria-label="Close Compact launchers"]');
    expect(create).not.toBeNull();
    expect(close).not.toBeNull();
    await act(async () => close!.click());
    expect(setTaskClosed).toHaveBeenCalledWith("task-1", true);

    await act(async () => create!.click());
    expect(document.querySelector(".task-create-dialog")?.textContent).toContain("Create a Task");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("favorites from the hover action, moves favorites left, and remembers them", async () => {
    const first = launchableTask();
    const second = { ...launchableTask(), id: "task-favorite", title: "Favorite candidate" };
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const props = { ...railProps({ tasks: [first, second] }), projectId: "favorite-project" };
    await act(async () => root.render(createElement(TaskRail, props)));

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Favorite Favorite candidate"]')!.click());
    expect([...container.querySelectorAll<HTMLElement>("[data-task-tab-id]")].map((tab) => tab.dataset.taskTabId))
      .toEqual(["task-favorite", "task-1"]);
    expect(container.querySelector('[aria-label="Unfavorite Favorite candidate"]')?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(TaskRail, props)));
    expect([...container.querySelectorAll<HTMLElement>("[data-task-tab-id]")].map((tab) => tab.dataset.taskTabId))
      .toEqual(["task-favorite", "task-1"]);

    await act(async () => root.unmount());
    window.localStorage.removeItem("termloop.taskFavorite.v1");
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renames an active Task inline after a tab double click", async () => {
    const task = launchableTask();
    const updateTask = vi.fn(async () => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, { ...railProps({ task }), updateTask })));

    await act(async () => container.querySelector<HTMLButtonElement>('[data-task-tab-id="task-1"]')!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Rename Compact launchers"]')!;
    expect(input.value).toBe("Compact launchers");
    await act(async () => typeInto(input, "Renamed from tab"));
    await act(async () => {
      input.blur();
      await Promise.resolve();
    });
    expect(updateTask).toHaveBeenCalledWith("task-1", "Renamed from tab", task.brief);

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("teaches the Task model only on a truly empty Project", () => {
    const empty = renderToStaticMarkup(createElement(TaskRail, { ...railProps(), tasks: [] }));
    expect(empty).toContain('class="task-empty"');
    expect(empty).toContain("Create your first Task");
    expect(empty).toContain("its own Git checkout");
    expect(empty).not.toContain("No active Tasks. Create one to start.");

    const withArchived = renderToStaticMarkup(createElement(TaskRail, { ...railProps({ archivedTaskCount: 2 }), tasks: [] }));
    expect(withArchived).not.toContain('class="task-empty"');
    expect(withArchived).toContain("No active Tasks. Create one to start.");
  });

  it("renders one mono meta line under the title, branch before facts", () => {
    const task: Task = {
      ...launchableTask(),
      worktree_health: { ...launchableTask().worktree_health!, change_count: 3, tracked_state: "changed" },
    };
    const markup = renderRail({ task });
    expect(markup).toContain('class="task-meta"');
    expect(markup).not.toContain("task-state-line");
    expect(markup.indexOf("task-meta-branch")).toBeLessThan(markup.indexOf(">3 changes</button>"));
    /// A deleting Task states its stage flag and nothing else on the line.
    const deleting = renderRail({ deleting: true });
    expect(deleting).toContain('class="task-meta-flag busy"');
    expect(deleting).not.toContain("task-meta-branch");
  });

  it("opens the Task on the stage from the row, and never a modal", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const opened: string[] = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, railProps({
      openTaskDetail: (taskId) => opened.push(taskId),
    }))));

    const row = () => container.querySelector<HTMLButtonElement>('[data-task-id="task-1"]')!;
    await act(async () => row().click());

    expect(opened).toEqual(["task-1"]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // The row keeps its Sessions on screen: opening the page is not collapsing.
    expect(container.querySelector(".task-children")).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the chevron as the way to fold a Task's Sessions away", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, railProps())));

    const chevron = () => container.querySelector<HTMLButtonElement>(".task-toggle")!;
    expect(container.querySelector(".task-children")).not.toBeNull();
    expect(chevron().getAttribute("aria-expanded")).toBe("true");

    await act(async () => chevron().click());
    expect(container.querySelector(".task-children")).toBeNull();
    expect(chevron().getAttribute("aria-expanded")).toBe("false");

    await act(async () => chevron().click());
    expect(container.querySelector(".task-children")).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("restores a Task's collapsed state after the rail remounts", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => root.render(createElement(TaskRail, railProps())));
    await act(async () => container.querySelector<HTMLButtonElement>(".task-toggle")!.click());
    expect(container.querySelector<HTMLButtonElement>(".task-toggle")?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => root.unmount());
    const nextRoot = createRoot(container);
    await act(async () => nextRoot.render(createElement(TaskRail, railProps())));
    expect(container.querySelector<HTMLButtonElement>(".task-toggle")?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => nextRoot.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("marks the row whose Task currently owns the stage", () => {
    const markup = renderToStaticMarkup(createElement(TaskRail, railProps({ detailTaskId: "task-1" })));
    expect(markup).toContain("showing-detail");
    expect(renderToStaticMarkup(createElement(TaskRail, railProps()))).not.toContain("showing-detail");
  });

  it("offers branch linking in plain words", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const task: Task = { ...worktreeLessTask(), branch: null };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, { ...railProps({ task }), tasks: [task] })));

    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='More actions for Compact launchers']")?.click());
    const menu = container.querySelector(".task-context-menu")!;
    expect(menu.textContent).toContain("Use existing branch");
    expect(menu.textContent).not.toContain("Bind branch");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Task rail create flow", () => {
  it("opens the Create Task dialog when the tab bar asks for it and keeps no title row", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const createRequestHandled = vi.fn();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, { ...railProps(), createRequested: true, createRequestHandled })));

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Create a Task");
    expect(createRequestHandled).toHaveBeenCalledTimes(1);
    /// The Tasks tab above names the view and hosts the action; the rail
    /// itself starts with the Task status tabs.
    expect(container.querySelector(".task-section .rail-header")).toBeNull();
    expect(container.querySelector(".task-section > :first-child")?.className).toBe("task-list-tabs");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("resolves a Task-only Project default into visible choices before creation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const loadProjectTaskAutomation = vi.fn(async () => ({
      configuration: {
        projectId: "project-1",
        createWorktree: false,
        worktreePrefix: "termloop",
        agentId: null,
        model: null,
        permission: null,
        reasoning: null,
        kickoffMessage: null,
      },
      stateRevision: 4,
    }));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, {
      ...railProps(),
      tasks: [],
      loadProjectTaskAutomation,
    })));

    await act(async () => container.querySelector<HTMLButtonElement>(".task-empty-create")?.click());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(loadProjectTaskAutomation).toHaveBeenCalledWith("project-1");
    expect(container.querySelector<HTMLButtonElement>('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector(".plan-card")).toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>(".start-chip")].every((option) => option.disabled)).toBe(true);
    expect(container.querySelector(".dialog-actions .primary-button")?.textContent).toBe("Create Task");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("creates, provisions, and launches the selected starts once the worktree is ready", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const createTask = vi.fn(async () => ({ taskId: "task-new" }));
    const provisionTaskWorktree = vi.fn(async (_params: TaskProvisionWorktreeParams) => undefined);
    const loadProjectTaskAutomation = vi.fn(async () => ({
      configuration: {
        projectId: "project-1",
        createWorktree: true,
        worktreePrefix: "feature",
        agentId: "claude",
        model: "opus[1m]",
        permission: "bypassPermissions" as const,
        reasoning: "high" as const,
        kickoffMessage: "Implement and verify this Task.",
      },
      stateRevision: 4,
    }));
    const launchTaskAgent = vi.fn(async () => undefined);
    const launchTaskTerminal = vi.fn(async () => undefined);
    const listProjectLocalBranches = vi.fn(async () => ({
      repository_root: "/repository",
      branches: [{ name: "main", exact_ref: "refs/heads/main" }],
      truncated: false,
    }));
    const readyTask: Task = {
      ...launchableTask(),
      id: "task-new",
      title: "Fix login redirect",
      branch: { repository_root: "/repository", name: "feature/fix-login-redirect" },
      worktree: { path: "/feature-fix-login-redirect_worktree" },
      worktree_health: { ...launchableTask().worktree_health!, checked_out_branch: "feature/fix-login-redirect" },
    };
    const { worktree_health: _health, ...awaitingHealthTask } = readyTask;
    const propsWith = (tasks: readonly Task[]): TaskRailProps => ({
      ...railProps(),
      tasks,
      createTask,
      provisionTaskWorktree,
      loadProjectTaskAutomation,
      launchTaskAgent,
      launchTaskTerminal,
      listProjectLocalBranches,
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, propsWith([]))));

    await act(async () => container.querySelector<HTMLButtonElement>(".task-empty-create")?.click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Create a Task");
    /// Before any title exists the proposal is already complete: an automatic
    /// branch name and a folder derived from it, never empty fields.
    expect(container.querySelector<HTMLInputElement>("#create-branch-name")?.value).toMatch(/^feature\/\w+/);
    expect(container.querySelector<HTMLInputElement>("#create-destination-path")?.value).toContain("_worktree");

    await act(async () => typeInto(container.querySelector<HTMLInputElement>("#task-title")!, "Fix login redirect"));
    expect(container.querySelector<HTMLInputElement>("#create-branch-name")?.value)
      .toBe("feature/fix-login-redirect");
    expect(container.querySelector<HTMLSelectElement>("#create-base-ref")?.value)
      .toBe("refs/heads/main");

    const claudeOption = [...container.querySelectorAll<HTMLButtonElement>(".start-chip")]
      .find((option) => option.textContent?.includes("Claude"))!;
    expect(claudeOption.getAttribute("aria-pressed")).toBe("true");

    const submit = [...container.querySelectorAll<HTMLButtonElement>(".primary-button")]
      .find((button) => button.textContent === "Create & Start")!;
    await act(async () => submit.click());

    expect(createTask).toHaveBeenCalledWith("Fix login redirect", null);
    expect(loadProjectTaskAutomation).toHaveBeenCalledWith("project-1");
    expect(provisionTaskWorktree).toHaveBeenCalledTimes(1);
    expect(provisionTaskWorktree.mock.calls[0]![0]).toMatchObject({
      taskId: "task-new",
      repositoryPath: "/repository",
      branchName: "feature/fix-login-redirect",
      branchMode: "create",
      baseRef: "refs/heads/main",
      destinationPath: "/feature-fix-login-redirect_worktree",
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(launchTaskAgent).not.toHaveBeenCalled();

    /// Provisioning completion and the first health observation are separate
    /// projections. Keep the user's launch intent across that brief gap.
    await act(async () => root.render(createElement(TaskRail, propsWith([awaitingHealthTask]))));
    expect(launchTaskAgent).not.toHaveBeenCalled();
    expect(container.querySelector(".task-meta-flag.busy")?.textContent).toContain("Checking");

    await act(async () => root.render(createElement(TaskRail, propsWith([readyTask]))));
    expect(launchTaskAgent).toHaveBeenCalledTimes(1);
    expect(launchTaskAgent).toHaveBeenCalledWith(
      "task-new",
      "claude",
      "opus[1m]",
      "bypassPermissions",
      "high",
      "Implement and verify this Task.",
    );
    expect(launchTaskTerminal).not.toHaveBeenCalled();

    /// A later projection of the same ready Task must not launch again.
    await act(async () => root.render(createElement(TaskRail, propsWith([{ ...readyTask }]))));
    expect(launchTaskAgent).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});

describe("Task rail agent cue", () => {
  it("surfaces a waiting agent as the row's one action and opens its terminal without expanding", async () => {
    const session = agentSession("waiting-agent");
    const task: Task = { ...launchableTask(), status: "closed" };
    const selectSession = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, {
      ...railProps({ task, sessions: [session], statuses: [agentStatus(session.id, "awaitingInput")] }),
      selectSession,
    })));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-task-list-tab="closed"]')!.click());

    const cue = container.querySelector<HTMLButtonElement>(".task-next-step.attention")!;
    expect(cue).not.toBeNull();
    expect(cue.textContent).toContain("Needs input · open Codex");
    expect(cue.getAttribute("aria-label")).toContain("Open Codex terminal");
    /// The row dot and the agent's own dot both carry the waiting tone.
    expect(container.querySelector(".task-dot.attention")).not.toBeNull();
    expect(container.querySelector('.task-agent-dot[data-tone="attention"]')).not.toBeNull();

    await act(async () => cue.click());
    expect(selectSession).toHaveBeenCalledWith("waiting-agent");
    /// Opening the terminal must not expand the Task.
    expect(container.querySelector(".task-children")).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows agents as dots on every row and reserves the action cue for folded rows", async () => {
    const session = agentSession("busy-agent");
    const closedTask: Task = { ...launchableTask(), status: "closed" };
    const collapsed = await renderRailTab({ task: closedTask, sessions: [session], statuses: [agentStatus(session.id, "working")] }, "closed");
    /// A working agent is progress, not a request: dots only, no action button.
    expect(collapsed).toContain('class="task-agent-dot agent-codex"');
    expect(collapsed).toContain('data-tone="working"');
    expect(collapsed).toContain('class="task-dot working"');
    expect(collapsed).not.toContain("task-next-step");
    /// The waiting cue exists only while the chevron hides the agent rows.
    const collapsedWaiting = await renderRailTab({ task: closedTask, sessions: [session], statuses: [agentStatus(session.id, "awaitingInput")] }, "closed");
    expect(collapsedWaiting).toContain('class="task-next-step attention"');
    expect(collapsedWaiting).toContain("Needs input · open Codex");
    /// Expanded, the waiting agent's own row sits directly below — a cue would
    /// state the same fact twice, and the retired attention pill never returns.
    const expanded = renderRail({ sessions: [session], statuses: [agentStatus(session.id, "awaitingInput")] });
    expect(expanded).not.toContain("task-next-step");
    expect(expanded).toContain('data-tone="attention"');
    expect(expanded).not.toContain("task-attention ");
  });
});

describe("Task rail live activity", () => {
  const taskAt = (id: string, title: string, worktreePath: string): Task => ({
    ...launchableTask(),
    id,
    title,
    branch: { repository_root: "/repository", name: `feature/${id}` },
    worktree: { path: worktreePath },
  });
  const agentAt = (id: string, cwd: string): Session => {
    const base = agentSession(id);
    return { ...base, process: { ...base.process, cwd } };
  };

  it("floats Tasks with live agents to the top, loudest first, quiet Tasks keeping their order", () => {
    const quiet = taskAt("task-quiet", "Quiet chore", "/repository/.worktrees/quiet");
    const busy = taskAt("task-busy", "Busy refactor", "/repository/.worktrees/busy");
    const waiting = taskAt("task-waiting", "Blocked migration", "/repository/.worktrees/blocked");
    const busyAgent = agentAt("busy-agent", "/repository/.worktrees/busy");
    const waitingAgent = agentAt("waiting-agent", "/repository/.worktrees/blocked");
    const markup = renderRail({
      tasks: [quiet, busy, waiting],
      sessions: [busyAgent, waitingAgent],
      statuses: [agentStatus(busyAgent.id, "working"), agentStatus(waitingAgent.id, "awaitingInput")],
    });
    const order = [...markup.matchAll(/data-task-tab-id="([^"]+)"/gu)].map((match) => match[1]);
    expect(order).toEqual(["task-waiting", "task-busy", "task-quiet"]);
    expect(markup).toContain('data-task-tab-id="task-waiting" data-tone="attention" aria-selected="true"');
    expect(markup).toContain('data-task-id="task-waiting"');
    expect(markup).not.toContain('data-task-id="task-busy"');
  });

  it("discloses a Task with a live agent over a stored collapse, honoring the preference once quiet", () => {
    writeTaskCollapsed("project-1", "task-1", true);
    const agent = agentSession("live-agent");
    const live = renderRail({ sessions: [agent], statuses: [agentStatus(agent.id, "working")] });
    expect(live).toContain('aria-label="Collapse Compact launchers"');
    expect(live).toContain("task-children");
    /// The disclosed row frames itself; the folded one stays a flat row.
    expect(live).toContain('data-disclosed="true"');
    const quietMarkup = renderRail();
    expect(quietMarkup).toContain('aria-label="Expand Compact launchers"');
    expect(quietMarkup).not.toContain("task-children");
    expect(quietMarkup).not.toContain("data-disclosed");
  });

  it("lets a chevron collapse win while live, re-arming auto-open once the Task goes quiet", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const agent = agentSession("live-agent");
    const liveProps = () => railProps({ sessions: [agent], statuses: [agentStatus(agent.id, "working")] });
    const toggle = () => container.querySelector<HTMLButtonElement>(".task-toggle")!;

    await act(async () => root.render(createElement(TaskRail, liveProps())));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    /// Quiet again: the click persisted as the stored preference.
    await act(async () => root.render(createElement(TaskRail, railProps())));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    /// The next live agent re-opens the row despite that stored collapse.
    await act(async () => root.render(createElement(TaskRail, liveProps())));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("discloses the row and opens the detail on a click, toggling once the detail is showing", async () => {
    writeTaskCollapsed("project-1", "task-1", true);
    const openTaskDetail = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskRail, railProps({ openTaskDetail }))));

    expect(container.querySelector(".task-children")).toBeNull();
    const row = () => container.querySelector<HTMLButtonElement>(".task-item")!;
    await act(async () => row().click());
    expect(openTaskDetail).toHaveBeenCalledWith("task-1");
    expect(container.querySelector(".task-children")).not.toBeNull();
    /// The disclosure persists like a chevron expand.
    expect(readTaskCollapsed("project-1", "task-1", true)).toBe(false);

    /// With the detail on the stage, a repeat press folds the row back and the
    /// next one grows it again, without re-raising the detail intent.
    await act(async () => root.render(createElement(TaskRail, railProps({ openTaskDetail, detailTaskId: "task-1" }))));
    await act(async () => row().click());
    expect(container.querySelector(".task-children")).toBeNull();
    expect(readTaskCollapsed("project-1", "task-1", false)).toBe(true);
    await act(async () => row().click());
    expect(container.querySelector(".task-children")).not.toBeNull();
    expect(openTaskDetail).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
