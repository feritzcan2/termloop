import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { ActiveAgentRail, activeAgentSections, type ActiveAgentRailProps } from "../src/renderer/ui/ActiveAgentRail.js";
import { WorkspaceViewSwitch } from "../src/renderer/ui/WorkspaceViewSwitch.js";
import { fullAgentCapability, launchOnlyGeminiCapability } from "./agent-capability-fixture.js";
import {
  persistActiveAgentFavoriteToggle,
  readActiveAgentFavorites,
  toggleActiveAgentFavorite,
  writeActiveAgentFavorites,
} from "../src/renderer/active-agent-favorites.js";

function agent(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project_id: "project-1",
    name: id,
    kind: "Agent",
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
    ask_to_source_session_id: null,
    process: {
      program: "/usr/local/bin/codex",
      args: [],
      cwd: `/repo/${id}`,
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: null,
    },
    ...overrides,
  } as Session;
}

function status(sessionId: string, value: AgentStatus["status"], observedAtEpochMs = 1): AgentStatus {
  return { sessionId, status: value, source: "appServer", observedAtEpochMs };
}

function props(sessions: readonly Session[], statuses: readonly AgentStatus[], reviewReadySessionIds: ReadonlySet<string>, selectedSession?: Session): ActiveAgentRailProps {
  return {
    sessions,
    projectFolder: "/repo/termloop-next",
    selectedSession,
    visibleSessionIds: new Set(),
    statusesById: new Map(statuses.map((value) => [value.sessionId, value])),
    reviewReadySessionIds,
    favoriteSessionIds: new Set(),
    taskAttachedSessionIds: new Set(),
    worktreeChangesBySessionId: new Map(),
    menuSessionId: undefined,
    selectSession: () => {},
    navigateSession: () => {},
    openSessionMenu: () => {},
    dismissSession: () => {},
    resumeSession: () => {},
    archiveSession: () => {},
    toggleFavoriteSession: () => {},
    openTaskChanges: () => {},
    searchOpen: false,
    setSearchOpen: () => {},
    nowEpochMs: 100,
  };
}

describe("Active Agent rail", () => {
  it("keeps the nested-agent detach control inside the helper hover area", async () => {
    const stylesheet = await readFile(new URL("../src/app.css", import.meta.url), "utf8");

    expect(stylesheet).toContain(
      ".active-agent-helper { gap: 0; margin: -1px 4px 2px -5px; padding-left: 14px; }",
    );
    expect(stylesheet).toContain(
      ".active-agent-helper .ask-to-helper-detach { top: 8px; left: 0; }",
    );
  });

  it("buckets action, current activity, and resting agents while preserving ties", () => {
    const workingOne = agent("working-one");
    const workingTwo = agent("working-two");
    const review = agent("review");
    const olderIdle = agent("older-idle");
    const recentIdle = agent("recent-idle");
    const unobserved = agent("unobserved");
    const interrupted = agent("interrupted");
    const waiting = agent("waiting");
    const values = [olderIdle, workingOne, review, unobserved, interrupted, recentIdle, workingTwo, waiting];
    const statuses = new Map<string, AgentStatus>([
      [workingOne.id, status(workingOne.id, "working")],
      [workingTwo.id, status(workingTwo.id, "working")],
      [review.id, status(review.id, "idle")],
      [olderIdle.id, status(olderIdle.id, "idle", 10)],
      [recentIdle.id, status(recentIdle.id, "idle", 20)],
      [interrupted.id, status(interrupted.id, "interrupted")],
      [waiting.id, status(waiting.id, "awaitingInput")],
    ]);

    expect(activeAgentSections(values, statuses, new Set([review.id]), new Set(), 100)).toEqual({
      actionNeeded: [waiting, review],
      interrupted: [interrupted],
      inProgress: [workingOne, workingTwo],
      resting: [recentIdle, olderIdle, unobserved],
      older: [],
      stopped: [],
    });
  });

  it("orders equal-priority Agents by last known activity across an app restart", () => {
    const olderWorking = agent("older-working");
    const recentWorking = agent("recent-working");
    const olderIdle = agent("older-idle");
    const recentIdle = agent("recent-idle");
    const withPlan = (session: Session, value: AgentStatus["status"], updatedAtEpochMs: number): AgentStatus => ({
      ...status(session.id, value, 0),
      plan: {
        source: "codexAppServer",
        explanation: null,
        steps: [],
        updatedAtEpochMs,
      },
    });
    const statuses = new Map<string, AgentStatus>([
      [olderWorking.id, withPlan(olderWorking, "working", 100)],
      [recentWorking.id, withPlan(recentWorking, "working", 200)],
      [olderIdle.id, withPlan(olderIdle, "idle", 300)],
      [recentIdle.id, withPlan(recentIdle, "idle", 400)],
    ]);

    const sections = activeAgentSections(
      [olderWorking, recentWorking, olderIdle, recentIdle],
      statuses,
      new Set(),
      new Set(),
      500,
    );

    expect(sections.inProgress).toEqual([recentWorking, olderWorking]);
    expect(sections.resting).toEqual([recentIdle, olderIdle]);
  });

  it("uses remembered activity when live observations reset on app restart", () => {
    const older = agent("older");
    const recent = agent("recent");
    const resetStatuses = new Map<string, AgentStatus>([
      [older.id, status(older.id, "idle", 0)],
      [recent.id, status(recent.id, "idle", 0)],
    ]);

    const sections = activeAgentSections(
      [older, recent],
      resetStatuses,
      new Set(),
      new Set(),
      500,
      new Map([[older.id, 100], [recent.id, 200]]),
    );

    expect(sections.resting).toEqual([recent, older]);
  });

  it("contains every ordinary Project agent, stopped ones included, but no terminal or persistent assistant", () => {
    const ordinary = agent("ordinary");
    const stopped = agent("stopped", { lifecycle_state: "exited" });
    const terminal = agent("terminal", { kind: "Terminal" });
    const assistant = agent("assistant", { process: { ...ordinary.process, template_ref: "builtin.assistant.activation" } });
    const legacySteward = agent("steward", { process: { ...ordinary.process, template_ref: "builtin.steward.executor" } });
    const legacyWorker = agent("worker", { process: { ...ordinary.process, template_ref: "builtin.worker.executor" } });
    const sections = activeAgentSections(
      [ordinary, stopped, terminal, assistant, legacySteward, legacyWorker],
      new Map(),
      new Set(),
      new Set(),
      100,
    );

    expect(sections).toEqual({
      actionNeeded: [],
      interrupted: [],
      inProgress: [],
      resting: [ordinary],
      older: [],
      stopped: [stopped],
    });
  });

  it("lists a failed resume in Stopped with its state, retry, and dismiss instead of dropping it", () => {
    const failed = agent("failed-resume", {
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "providerSessionUnavailable",
      retryable: true,
    });
    const working = agent("working");
    const sections = activeAgentSections(
      [failed, working],
      new Map([[working.id, status(working.id, "working")]]),
      new Set(),
      new Set(),
      100,
    );

    expect(sections.stopped).toEqual([failed]);
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [failed, working],
      [status(working.id, "working")],
      new Set(),
    )));
    expect(markup).toContain('data-active-agent-section="Stopped"');
    expect(markup).toContain('data-session-id="failed-resume"');
    expect(markup).toContain("Retry available");
    expect(markup).toContain('aria-label="Retry failed-resume"');
    // Stopped is the quietest section, so it follows every activity bucket.
    expect(markup.indexOf('data-active-agent-section="In progress"')).toBeLessThan(markup.indexOf('data-active-agent-section="Stopped"'));
  });

  it("orders Stopped by recoverability and counts stopped agents in the rail total", () => {
    const exited = agent("exited-agent", { lifecycle_state: "exited" });
    const stale = agent("stale-agent", { lifecycle_state: "stale" });
    const failed = agent("failed-agent", { lifecycle_state: "resumeFailed", retryable: true });
    const sections = activeAgentSections([exited, stale, failed], new Map(), new Set(), new Set(), 100);

    expect(sections.stopped).toEqual([failed, stale, exited]);
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props([exited, stale, failed], [], new Set())));
    // Three Agents exist here, so the rail never offers the first-run pitch
    // that claims nothing has run in this Project.
    expect(markup).not.toContain("Start your first Agent");
  });

  it("keeps a stopped favorite ahead of other stopped agents", () => {
    const favorite = agent("favorite-exited", { lifecycle_state: "exited" });
    const other = agent("other-failed", { lifecycle_state: "resumeFailed", retryable: true });
    const sections = activeAgentSections(
      [other, favorite],
      new Map(),
      new Set(),
      new Set([favorite.id]),
      100,
    );

    expect(sections.stopped).toEqual([favorite, other]);
  });

  it("keeps a group whose source stopped in the live bucket of its running helper", () => {
    const source = agent("stopped-source", { lifecycle_state: "exited" });
    const helper = agent("live-helper", { ask_to_source_session_id: source.id });
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [source, helper],
      [status(helper.id, "awaitingInput")],
      new Set(),
    )));

    expect(markup).toContain('data-active-agent-section="Action needed"');
    expect(markup).not.toContain('data-active-agent-section="Stopped"');
    expect(markup).toContain('data-session-id="stopped-source"');
    expect(markup).toContain('data-session-id="live-helper"');
  });

  it("separates Agents whose latest activity is more than ten minutes old", () => {
    const nowEpochMs = 1_000_000;
    const recent = agent("recent");
    const boundary = agent("boundary");
    const older = agent("older");
    const unobserved = agent("unobserved");
    const statuses = [
      status(recent.id, "idle", nowEpochMs - 100),
      status(boundary.id, "idle", nowEpochMs - 600_000),
      status(older.id, "idle", nowEpochMs - 600_001),
    ];
    const sections = activeAgentSections(
      [older, recent, unobserved, boundary],
      new Map(statuses.map((value) => [value.sessionId, value])),
      new Set(),
      new Set(),
      nowEpochMs,
    );

    expect(sections.resting).toEqual([recent, boundary, unobserved]);
    expect(sections.older).toEqual([older]);
    const railProps = props([older, recent, unobserved, boundary], statuses, new Set());
    railProps.nowEpochMs = nowEpochMs;
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, railProps));
    expect(markup.indexOf('data-session-id="recent"')).toBeLessThan(markup.indexOf('data-active-agent-section="10m+ ago"'));
    expect(markup.indexOf('data-active-agent-section="10m+ ago"')).toBeLessThan(markup.indexOf('data-session-id="older"'));
  });

  it("keeps old waiting and interrupted agents in their action sections", () => {
    const nowEpochMs = 1_000_000;
    const waiting = agent("old-waiting");
    const interrupted = agent("old-interrupted");
    const sections = activeAgentSections(
      [interrupted, waiting],
      new Map([
        [waiting.id, status(waiting.id, "awaitingInput", nowEpochMs - 600_001)],
        [interrupted.id, status(interrupted.id, "interrupted", nowEpochMs - 600_001)],
      ]),
      new Set(),
      new Set(),
      nowEpochMs,
    );

    expect(sections.actionNeeded).toEqual([waiting]);
    expect(sections.interrupted).toEqual([interrupted]);
    expect(sections.older).toEqual([]);
  });

  it("keeps a still-working Agent active after ten minutes without a new status observation", () => {
    const nowEpochMs = 1_000_000;
    const working = agent("long-working");
    const idle = agent("long-idle");
    const statuses = [
      status(working.id, "working", nowEpochMs - 600_001),
      status(idle.id, "idle", nowEpochMs - 600_001),
    ];
    const sections = activeAgentSections(
      [working, idle],
      new Map(statuses.map((value) => [value.sessionId, value])),
      new Set(),
      new Set(),
      nowEpochMs,
    );

    expect(sections.inProgress).toEqual([working]);
    expect(sections.older).toEqual([idle]);
    const railProps = props([working, idle], statuses, new Set());
    railProps.nowEpochMs = nowEpochMs;
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, railProps));
    expect(markup.indexOf('data-session-id="long-working"')).toBeLessThan(markup.indexOf('data-active-agent-section="10m+ ago"'));
  });

  it("renders compact action and in-progress sections in that order", () => {
    const working = agent("working");
    const waiting = agent("waiting");
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [working, waiting],
      [status(working.id, "working"), status(waiting.id, "awaitingInput")],
      new Set(),
    )));

    expect(markup).toContain('class="session-row active-agent-row"');
    expect(markup).toContain('aria-roledescription="draggable"');
    expect(markup.indexOf('data-active-agent-section="Action needed"')).toBeLessThan(markup.indexOf('data-active-agent-section="In progress"'));
    expect(markup.indexOf('data-session-id="waiting"')).toBeLessThan(markup.indexOf('data-session-id="working"'));
    /// The waiting count moved onto the Agents tab; the rail keeps no heading.
    expect(markup).not.toContain("need you");
    expect(markup).not.toContain("active-agent-heading");
  });

  it("renders interrupted agents above in-progress and resting agents", () => {
    const working = agent("working");
    const interrupted = agent("interrupted");
    const idle = agent("idle");
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [idle, working, interrupted],
      [status(idle.id, "idle"), status(working.id, "working"), status(interrupted.id, "interrupted")],
      new Set(),
    )));

    expect(markup.indexOf('data-active-agent-section="Interrupted"')).toBeLessThan(markup.indexOf('data-active-agent-section="In progress"'));
    expect(markup.indexOf('data-active-agent-section="In progress"')).toBeLessThan(markup.indexOf('data-active-agent-section="Idle / paused"'));
  });

  it("shows structured todo progress in the row and keeps details in its tooltip", () => {
    const planning = agent("planning");
    const planningStatus: AgentStatus = {
      ...status(planning.id, "working"),
      plan: {
        source: "codexAppServer",
        explanation: "Keep one current projection.",
        steps: [
          { text: "Persist the plan", status: "completed" },
          { text: "Render Active Agents", status: "inProgress" },
        ],
        updatedAtEpochMs: 2,
      },
    };
    const markup = renderToStaticMarkup(createElement(
      ActiveAgentRail,
      props([planning], [planningStatus], new Set()),
    ));

    expect(markup).toContain('class="agent-todo-count"');
    expect(markup).toContain('class="agent-todo-progress">1/2</span>');
    expect(markup).toContain('class="agent-todo-dismiss-glyph" aria-hidden="true">×</span>');
    expect(markup).toContain('class="agent-todo-tooltip" role="tooltip"');
    expect(markup).toContain("Persist the plan");
    expect(markup).toContain("Render Active Agents");
    expect(markup).not.toContain("Keep one current projection.");
    expect(markup).not.toContain("<details");

    const resumingMarkup = renderToStaticMarkup(createElement(
      ActiveAgentRail,
      props([{ ...planning, lifecycle_state: "resuming" }], [planningStatus], new Set()),
    ));
    expect(resumingMarkup).toContain('class="agent-todo-count"');
    expect(resumingMarkup).toContain('class="agent-todo-progress">1/2</span>');

    const completedStatus: AgentStatus = {
      ...planningStatus,
      plan: {
        ...planningStatus.plan!,
        steps: planningStatus.plan!.steps.map((step) => ({ ...step, status: "completed" as const })),
      },
    };
    const unselectedCompleted = renderToStaticMarkup(createElement(
      ActiveAgentRail,
      props([planning], [completedStatus], new Set()),
    ));
    expect(unselectedCompleted).toContain('class="agent-todo-count done"');
    expect(unselectedCompleted).toContain('class="agent-todo-progress">2/2</span>');
    const selectedCompleted = renderToStaticMarkup(createElement(
      ActiveAgentRail,
      props([planning], [completedStatus], new Set(), planning),
    ));
    expect(selectedCompleted).toContain('class="agent-todo-count done"');
    expect(selectedCompleted).not.toContain("<details");
  });

  it("keeps shared-worktree agents as independent rows with a worktree label on each", () => {
    const shared = (id: string) => agent(id, { process: { ...agent("base").process, cwd: "/repo/.worktrees/shared" } });
    const first = shared("first");
    const second = shared("second");
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [first, second],
      [status(first.id, "working"), status(second.id, "working")],
      new Set(),
    )));

    expect(markup).not.toContain("active-agent-worktree-group");
    expect(markup.match(/class="row-subtitle" title="\/repo\/\.worktrees\/shared">shared<\/small>/gu)).toHaveLength(2);
    expect(markup.match(/data-session-id=/gu)).toHaveLength(2);
  });

  it("keeps an Ask-To helper joined to its exact source across aggregate state buckets", () => {
    const source = agent("source", { name: "Source agent" });
    const helper = agent("helper", {
      name: "Helper agent",
      ask_to_source_session_id: source.id,
      process: { ...agent("base").process, template_ref: "builtin.agent.ask-to-helper" },
    });
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [helper, source],
      [status(source.id, "idle"), status(helper.id, "awaitingInput")],
      new Set(),
    )));

    const actionSection = markup.indexOf('data-active-agent-section="Action needed"');
    const sourceRow = markup.indexOf('data-session-id="source"');
    const helperGroup = markup.indexOf('class="ask-to-helper compact active-agent-helper"');
    const helperRow = markup.indexOf('data-session-id="helper"');
    expect(actionSection).toBeLessThan(sourceRow);
    expect(sourceRow).toBeLessThan(helperGroup);
    expect(helperGroup).toBeLessThan(helperRow);
    expect(markup.match(/data-session-id="helper"/gu)).toHaveLength(1);
    expect(markup).toContain('class="ask-to-helper compact active-agent-helper"');
    expect(markup).toContain("from Source agent");
    expect(markup).not.toContain('class="ask-to-helper-source"');
    expect(markup).not.toContain('class="ask-to-helper-connector"');
    expect(markup).not.toContain('data-active-agent-section="Idle / paused"');
  });

  it("nests a native fork directly beneath its exact source", () => {
    const source = agent("source", { name: "Source agent" });
    const fork = agent("fork", {
      name: "Fork agent",
      fork_source_session_id: source.id,
    });
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [fork, source],
      [status(source.id, "idle"), status(fork.id, "working")],
      new Set(),
    )));

    expect(markup.indexOf('data-session-id="source"')).toBeLessThan(markup.indexOf("forked from Source agent"));
    expect(markup.indexOf("forked from Source agent")).toBeLessThan(markup.indexOf('data-session-id="fork"'));
    expect(markup).toContain('class="ask-to-helper compact active-agent-helper"');
    expect(markup.match(/data-session-id="fork"/gu)).toHaveLength(1);
  });

  it("nests an Ask-To helper under its projected source even after that source stopped", () => {
    const stoppedSource = agent("stopped-source", { lifecycle_state: "exited" });
    const helper = agent("orphaned-helper", { ask_to_source_session_id: stoppedSource.id });
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [stoppedSource, helper],
      [status(helper.id, "working")],
      new Set(),
    )));

    // The source is listed now that the rail keeps stopped Agents, so the
    // relation Core projected is the one the rail renders. The helper only went
    // top-level before because its source was hidden from this rail.
    expect(markup).toContain('data-session-id="orphaned-helper"');
    expect(markup).toContain('data-session-id="stopped-source"');
    expect(markup).toContain('class="ask-to-helper compact active-agent-helper"');
    expect(markup.indexOf('data-session-id="stopped-source"')).toBeLessThan(markup.indexOf('data-session-id="orphaned-helper"'));
  });

  it("hides the Project root folder but keeps real worktree names", () => {
    const projectAgent = agent("project-agent", {
      process: { ...agent("base").process, cwd: "/repo/termloop-next" },
    });
    const worktreeAgent = agent("worktree-agent", {
      process: { ...agent("base").process, cwd: "/repo/.worktrees/deployment_worktree" },
    });
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, props(
      [projectAgent, worktreeAgent],
      [status(projectAgent.id, "idle"), status(worktreeAgent.id, "idle")],
      new Set(),
    )));

    expect(markup).not.toContain('class="row-subtitle" title="/repo/termloop-next">termloop-next</small>');
    expect(markup).toContain('class="row-subtitle" title="/repo/.worktrees/deployment_worktree">deployment_worktree</small>');
  });

  it("keeps favorites in their activity section and sorts them first within it", () => {
    const waiting = agent("waiting");
    const favoriteWaiting = agent("favorite-waiting");
    const interrupted = agent("interrupted");
    const favoriteInterrupted = agent("favorite-interrupted");
    const favoriteIdle = agent("favorite-idle");
    const working = agent("working");
    const favoriteWorking = agent("favorite-working");
    const values = [waiting, interrupted, favoriteIdle, working, favoriteWaiting, favoriteInterrupted, favoriteWorking];
    const statuses = [
      status(waiting.id, "awaitingInput"),
      status(favoriteWaiting.id, "awaitingInput"),
      status(interrupted.id, "interrupted"),
      status(favoriteInterrupted.id, "interrupted"),
      status(favoriteIdle.id, "idle", 20),
      status(working.id, "working"),
      status(favoriteWorking.id, "working"),
    ];
    const favoriteIds = new Set([
      favoriteWaiting.id,
      favoriteInterrupted.id,
      favoriteIdle.id,
      favoriteWorking.id,
    ]);
    const sections = activeAgentSections(values, new Map(statuses.map((value) => [value.sessionId, value])), new Set(), favoriteIds, 100);

    expect(sections.resting).toEqual([favoriteIdle]);
    expect(sections.actionNeeded).toEqual([favoriteWaiting, waiting]);
    expect(sections.interrupted).toEqual([favoriteInterrupted, interrupted]);
    expect(sections.inProgress).toEqual([favoriteWorking, working]);
    const railProps = props(values, statuses, new Set());
    railProps.favoriteSessionIds = favoriteIds;
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, railProps));
    expect(markup).not.toContain('data-active-agent-section="Favs"');
    expect(markup.indexOf('data-active-agent-section="Action needed"')).toBeLessThan(markup.indexOf('data-active-agent-section="Interrupted"'));
    expect(markup.indexOf('data-active-agent-section="Interrupted"')).toBeLessThan(markup.indexOf('data-active-agent-section="In progress"'));
    expect(markup.indexOf('data-active-agent-section="In progress"')).toBeLessThan(markup.indexOf('data-active-agent-section="Idle / paused"'));
    expect(markup.indexOf('data-session-id="favorite-waiting"')).toBeLessThan(markup.indexOf('data-session-id="waiting"'));
    expect(markup.indexOf('data-session-id="favorite-interrupted"')).toBeLessThan(markup.indexOf('data-session-id="interrupted"'));
    expect(markup.indexOf('data-session-id="favorite-working"')).toBeLessThan(markup.indexOf('data-session-id="working"'));
    expect(markup.match(/data-session-id="favorite-working"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Remove favorite-working from Favs" aria-pressed="true"');
    expect(markup).toContain('aria-label="Add working to Favs" aria-pressed="false"');
  });

  it("keeps old favorites in Older and sorts them first within that section", () => {
    const favorite = agent("old-favorite");
    const older = agent("older");
    const nowEpochMs = 1_000_000;
    const statuses = [
      status(favorite.id, "idle", nowEpochMs - 600_001),
      status(older.id, "idle", nowEpochMs - 600_002),
    ];
    const favoriteIds = new Set([favorite.id]);
    const sections = activeAgentSections(
      [older, favorite],
      new Map(statuses.map((value) => [value.sessionId, value])),
      new Set(),
      favoriteIds,
      nowEpochMs,
    );

    expect(sections.older).toEqual([favorite, older]);
    const railProps = props([older, favorite], statuses, new Set());
    railProps.favoriteSessionIds = favoriteIds;
    railProps.nowEpochMs = nowEpochMs;
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, railProps));
    expect(markup.indexOf('data-session-id="old-favorite"')).toBeLessThan(markup.indexOf('data-session-id="older"'));
  });

  it("keeps favorited action-needed agents in the header attention count", () => {
    const favoriteWaiting = agent("favorite-waiting");
    const railProps = props([favoriteWaiting], [status(favoriteWaiting.id, "awaitingInput")], new Set());
    railProps.favoriteSessionIds = new Set([favoriteWaiting.id]);
    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, railProps));

    expect(markup).not.toContain('data-active-agent-section="Favs"');
    expect(markup).toContain('data-active-agent-section="Action needed"');
  });

  it("keeps manually grouped peer Agents together in the loudest member's section", () => {
    const waiting = agent("group-waiting");
    const working = agent("group-working");
    const unrelated = agent("unrelated");
    const railProps = props(
      [unrelated, waiting, working],
      [
        status(unrelated.id, "idle"),
        status(waiting.id, "awaitingInput"),
        status(working.id, "working"),
      ],
      new Set(),
    );
    railProps.agentGroups = [{ sessionIds: [waiting.id, working.id] }];

    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, railProps));
    const groupStart = markup.indexOf('data-agent-group="manual"');
    const actionEnd = markup.indexOf('data-active-agent-section="Idle / paused"');
    expect(groupStart).toBeGreaterThan(markup.indexOf('data-active-agent-section="Action needed"'));
    expect(groupStart).toBeLessThan(actionEnd);
    expect(markup).toContain('aria-label="Agent group with 2 agents"');
    expect(markup).toContain('data-agent-group-size="2"');
    expect(markup.indexOf('data-session-id="group-waiting"')).toBeLessThan(markup.indexOf('data-session-id="group-working"'));
  });

  it("keeps exact Ask-To nesting intact inside a manual peer group", () => {
    const source = agent("source");
    const helper = agent("helper", { ask_to_source_session_id: source.id });
    const peer = agent("peer");
    const railProps = props(
      [source, helper, peer],
      [status(source.id, "idle"), status(helper.id, "idle"), status(peer.id, "idle")],
      new Set(),
    );
    railProps.agentGroups = [{ sessionIds: [source.id, peer.id] }];

    const markup = renderToStaticMarkup(createElement(ActiveAgentRail, railProps));
    expect(markup).toContain('aria-label="Agent group with 3 agents"');
    expect(markup).toContain("active-agent-helper");
    expect(markup.indexOf('data-session-id="source"')).toBeLessThan(markup.indexOf('data-session-id="helper"'));
    expect(markup.indexOf('data-session-id="helper"')).toBeLessThan(markup.indexOf('data-session-id="peer"'));
  });
});

describe("Active Agent favorites", () => {
  it("round-trips valid project favorites and rejects malformed values", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    let favorites = toggleActiveAgentFavorite({}, "project-1", "session-1");
    favorites = toggleActiveAgentFavorite(favorites, "project-1", "session-2");
    writeActiveAgentFavorites(favorites, storage);
    expect(readActiveAgentFavorites(storage)).toEqual({ "project-1": ["session-1", "session-2"] });

    favorites = toggleActiveAgentFavorite(favorites, "project-1", "session-1");
    expect(favorites).toEqual({ "project-1": ["session-2"] });
    values.set("termloop.activeAgentFavorites.v1", JSON.stringify({ "project-1": ["session-2", 4, "session-2"], invalid: "nope" }));
    expect(readActiveAgentFavorites(storage)).toEqual({ "project-1": ["session-2"] });
  });

  it("persists a toggle before returning so a new renderer can restore it", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    const next = persistActiveAgentFavoriteToggle({}, "project-1", "session-1", storage);

    expect(next).toEqual({ "project-1": ["session-1"] });
    expect(readActiveAgentFavorites(storage)).toEqual(next);
  });
});

describe("Workspace view switch", () => {
  it("keeps icon-only views on the left and all launch actions on the same bar", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "agents",
      disabled: false,
      agents: [fullAgentCapability("claude"), fullAgentCapability("codex"), launchOnlyGeminiCapability()],
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
    }));
    expect(markup).toContain('aria-label="Tasks and Sessions view"');
    expect(markup).toContain('aria-label="All active agents view"');
    expect(markup).toContain('aria-selected="true" class="selected" title="All active agents"');
    expect(markup).toContain('class="workspace-launch-actions" aria-label="Launch Session"');
    expect(markup).toContain('aria-label="New Terminal"');
    expect(markup).toContain('aria-label="New Claude Session"');
    expect(markup).toContain('aria-label="New Codex Session"');
    expect(markup).toContain('aria-label="New Gemini CLI Session (launch only)"');
    expect(markup).toContain('aria-label="Session History"');
    expect(markup).toContain('class="workspace-history-separator"');
    expect(markup.indexOf('aria-label="New Gemini CLI Session (launch only)"')).toBeLessThan(markup.indexOf('aria-label="Session History"'));
    expect(markup.indexOf('class="workspace-view-switch"')).toBeLessThan(markup.indexOf('class="workspace-launch-actions"'));
    expect(markup).not.toContain(">Tasks and Sessions<");
    expect(markup).not.toContain(">All active agents<");
    // The named dev server offer is absent unless the Shell asks for it.
    expect(markup).not.toContain("Set up dev server");
  });

  it("marks waiting work with a dot, not a number, and hosts the selected view's action", () => {
    const base = { view: "overview" as const, disabled: false, select: () => {}, launchTerminal: async () => {}, launchAgent: async () => {} };
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      ...base,
      attentionCount: 2,
      taskAttentionCount: 1,
      viewAction: { label: "Create Task", icon: "add", run: () => {} },
    }));
    expect(markup.match(/class="workspace-view-attention"/gu)).toHaveLength(2);
    expect(markup).toContain('aria-label="2 agents need you"');
    expect(markup).toContain('aria-label="1 Tasks need you"');
    expect(markup).not.toContain(">2</span>");
    expect(markup).toContain('class="workspace-view-action" title="Create Task" aria-label="Create Task"');
    expect(markup.indexOf('class="workspace-view-switch"')).toBeLessThan(markup.indexOf('class="workspace-view-action"'));
    expect(markup.indexOf('class="workspace-view-action"')).toBeLessThan(markup.indexOf('class="workspace-launch-actions"'));

    const searching = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      ...base,
      view: "agents",
      viewAction: { label: "Close agent search", icon: "search", run: () => {}, pressed: true },
    }));
    expect(searching).toContain('aria-pressed="true"');
    expect(searching).not.toContain("workspace-view-attention");
    expect(renderToStaticMarkup(createElement(WorkspaceViewSwitch, base))).not.toContain("workspace-view-action");
  });

  it("keeps Task Settings at the far edge after Create Task", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "overview",
      disabled: false,
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
      viewAction: { label: "Create Task", icon: "add", run: () => {} },
      settingsAction: { label: "Task Settings", icon: "settings", run: () => {}, pressed: true },
    }));
    const createTask = markup.indexOf('aria-label="Create Task"');
    const taskSettings = markup.indexOf('aria-label="Task Settings"');
    expect(createTask).toBeGreaterThan(-1);
    expect(taskSettings).toBeGreaterThan(createTask);
    expect(markup).toContain('class="workspace-view-action settings"');
    expect(markup).toContain('title="Task Settings"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("stacks the view row above the launch row instead of sharing one line", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "overview",
      disabled: false,
      agents: [fullAgentCapability("claude")],
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
      runDevServer: { name: "dev", running: false, start: () => {}, edit: () => {} },
      viewAction: { label: "Create Task", icon: "add", run: () => {} },
    }));
    // The tabs and the selected view's action share the first row...
    expect(markup.startsWith('<div class="workspace-view-bar"><div class="workspace-view-row"><div class="workspace-view-switch" role="tablist"')).toBe(true);
    const action = markup.indexOf('class="workspace-view-action"');
    const launch = markup.indexOf('<div class="workspace-launch-actions"');
    expect(action).toBeGreaterThan(-1);
    expect(action).toBeLessThan(launch);
    // ...and the row closes before the launch row opens; RUN leads it and
    // Session History closes it.
    expect(markup.slice(action, launch)).toMatch(/<\/button><\/div>$/u);
    expect(markup.slice(launch)).toMatch(/^<div class="workspace-launch-actions" aria-label="Launch Session"><span class="run-dev-server-chip">/u);
    expect(markup).toMatch(/aria-label="Session History"[^>]*><svg[^]*?<\/svg><\/button><\/div><\/div>$/u);
  });

  it("stays in place with no tab selected while another rail owns the sidebar", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "agents",
      viewActive: false,
      disabled: false,
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
    }));
    expect(markup).toContain('aria-label="All active agents view"');
    expect(markup).toContain('aria-label="Tasks and Sessions view"');
    expect(markup).toContain('aria-label="Project Steward view"');
    expect(markup).not.toContain('class="selected"');
    expect(markup).not.toContain('aria-selected="true"');
    // Launch actions follow the underlying view, so the bar keeps its shape.
    expect(markup).toContain('class="workspace-launch-actions" aria-label="Launch Session"');
  });

  it("marks the history launcher when its rail owns the sidebar", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "history",
      disabled: false,
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
    }));
    expect(markup).toContain('class="workspace-history selected"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("gives the Steward its own peer tab and parks the launch actions there", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "steward",
      disabled: false,
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
    }));
    expect(markup).toContain('aria-label="Project Steward view"');
    expect(markup).toContain('aria-selected="true" class="selected" title="Project Steward and Playbook"');
    // Launching terminals is a workspace action; the Steward view has its own.
    expect(markup).not.toContain('class="workspace-launch-actions"');
  });

  it("names the dev server offer beside the launchers until a Project has one", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "overview",
      disabled: false,
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
      setupDevServer: () => {},
    }));
    expect(markup).toContain("Set up dev server");
    expect(markup).toContain('class="setup-dev-server"');
    // It sits with the launchers, ahead of the terminal and agent glyphs.
    expect(markup.indexOf("setup-dev-server")).toBeLessThan(markup.indexOf('id="new-terminal"'));
  });

  it("turns the same slot into the run button once the dev server exists", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "overview",
      disabled: false,
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
      runDevServer: { name: "Dev server", running: false, start: () => {}, edit: () => {} },
    }));
    // The slot reads RUN: a Project has one dev server, so the name it runs
    // belongs to the tooltip and the accessible label, not to rail width.
    expect(markup).toContain('class="run-dev-server-label">RUN<');
    expect(markup).toContain("Start Dev server in this Project&#x27;s own checkout");
    expect(markup).toContain('aria-label="Run Dev server in this Project&#x27;s own checkout"');
    // The offer and the run button never appear together.
    expect(markup).not.toContain("Set up dev server");
    // Editing is the only Project-level route to this run's settings and its
    // Improve-with-agent launcher, so the chip must carry it.
    expect(markup).toContain("Edit run configuration Dev server");
  });

  it("states a live Project run instead of offering to start it again", () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceViewSwitch, {
      view: "overview",
      disabled: false,
      select: () => {},
      launchTerminal: async () => {},
      launchAgent: async () => {},
      runDevServer: { name: "Dev server", running: true, start: () => {}, edit: () => {} },
    }));
    expect(markup).toContain("run-dev-server running");
    expect(markup).toContain("already running in this Project&#x27;s checkout");
    expect(markup).toContain("run-dev-server-dot");
    // The label does not flip with the process: the dot and the colour carry
    // the state, so the slot never changes width under the pointer.
    expect(markup).toContain('class="run-dev-server-label">RUN<');
    expect(markup).toContain('aria-label="Open the running Dev server"');
  });
});
