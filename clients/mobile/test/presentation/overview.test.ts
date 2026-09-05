import type { AgentStatusDto, SessionDto, TaskDto } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import type { ConnectionProfile, MobileOverview } from "../../src/application/ports";
import {
  connectionRouteParams,
  missingSessionRouteState,
  resolveSessionRouteConnectionId,
} from "../../src/features/connection/connection-route";
import {
  preferredConnectionId,
  shouldResetConnectionTransports,
} from "../../src/features/connection/connection-resilience";
import {
  refreshIndicatorForOverviewRead,
  snapshotWhileBackgrounded,
  snapshotWhileUnavailable,
} from "../../src/features/overview/overview-resilience";
import {
  buildLocatedProjectSummaries,
  buildProjectOverview,
  buildProjectSummaries,
  connectionSummaryLine,
} from "../../src/presentation/attention-overview";
import { connectionBlockCopy, connectionPresentation, shortContractIdentity } from "../../src/presentation/connection-presentation";
import { ellipsizeMiddle, shortenPath } from "../../src/presentation/dto-readers";
import { relativeAge, relativeAgeSentence } from "../../src/presentation/relative-time";
import { projectSelectorGroups } from "../../src/presentation/project-selector-model";
import {
  provisioningFailureNote,
  taskAtAGlance,
  taskBranchNote,
  taskChangeLabel,
  taskRemoteActionNote,
  taskStage,
} from "../../src/presentation/task-presentation";
import {
  fixtureAgentStatuses,
  fixtureProjects,
  fixtureSessions,
  fixtureTasks,
} from "../../src/fixtures/mobile-overview";

const now = 1_786_617_600_000;

/// Built from the foundation's own fixtures wherever possible, so a change to the
/// generated DTO shapes fails here rather than in a hand-written copy that has quietly
/// drifted from the wire.
const baseOverview: MobileOverview = {
  projects: fixtureProjects,
  stewardEnabledProjectIds: fixtureProjects.map((project) => project.id),
  stewardExecutorSessionIds: {},
  agentGroupsByProject: {},
  tasks: fixtureTasks,
  sessions: fixtureSessions,
  agentStatuses: fixtureAgentStatuses,
};

const mac = (id: string, name: string): ConnectionProfile => ({
  id,
  name,
  endpointLabel: `${name}.local`,
  availability: "online",
  lastConnectedAtEpochMs: now,
  productVersion: "2.0.0",
  contractIdentity: "contract",
});

function session(overrides: Partial<SessionDto>): SessionDto {
  const first = fixtureSessions[0];
  if (!first) throw new Error("the foundation fixture must provide a session");
  return { ...first, ...overrides };
}

function status(overrides: Partial<AgentStatusDto>): AgentStatusDto {
  const first = fixtureAgentStatuses[0];
  if (!first) throw new Error("the foundation fixture must provide an agent status");
  return { ...first, ...overrides };
}

function task(overrides: Partial<TaskDto>): TaskDto {
  const first = fixtureTasks[0];
  if (!first) throw new Error("the foundation fixture must provide a task");
  return { ...first, ...overrides };
}

/// A Task with no branch, no worktree, and no observation at all. The optional members
/// are removed rather than set to `undefined`, because `exactOptionalPropertyTypes`
/// distinguishes "absent from the projection" from "present and undefined" — and so
/// does the presentation being tested.
function planningTask(): TaskDto {
  const next = task({ branch: null, worktree: null });
  delete next.worktree_health;
  delete next.worktree_presence;
  delete next.worktree_provisioning;
  return next;
}

describe("project overview sectioning", () => {
  it("keeps each Project's Mac location when flattening several connections", () => {
    const secondOverview: MobileOverview = {
      projects: fixtureProjects.map((project) => ({ ...project, id: `second-${project.id}` })),
      stewardEnabledProjectIds: [],
      stewardExecutorSessionIds: {},
      agentGroupsByProject: {},
      tasks: [],
      sessions: [],
      agentStatuses: [],
    };
    const summaries = buildLocatedProjectSummaries([
      { connection: mac("mac-home", "Home Mac"), overview: baseOverview },
      { connection: mac("mac-office", "Office Mac"), overview: secondOverview },
    ]);

    expect(summaries.map(({ connection, summary }) => [connection.id, summary.project.id]))
      .toEqual([
        ...fixtureProjects.map((project) => ["mac-home", project.id]),
        ...secondOverview.projects.map((project) => ["mac-office", project.id]),
      ]);
  });

  it("puts an agent that is waiting into Needs you and keeps it in Agents", () => {
    const model = buildProjectOverview(baseOverview, "project-termloop-next");
    expect(model.needsYou.map((row) => row.sessionId)).toEqual(["session-claude"]);
    /// The section is a lens on the same list, not a second one — otherwise the chip
    /// count and the rows can disagree.
    expect(model.agents.map((row) => row.sessionId)).toContain("session-claude");
    expect(model.counts.needsYou).toBe(1);
  });

  it("shows a completed idle turn as Needs review when the client observed its transition", () => {
    const idle: MobileOverview = {
      ...baseOverview,
      agentStatuses: [status({ sessionId: "session-claude", status: "idle" })],
    };
    const model = buildProjectOverview(idle, "project-termloop-next", new Set(["session-claude"]));
    expect(model.needsYou[0]?.state).toMatchObject({ id: "review", label: "Needs review", tone: "review" });
    expect(model.tasks[0]?.attention).toMatchObject({ sessionId: "session-claude", tone: "review" });
  });

  it("gives every attachable quiet agent an explicit Active label", () => {
    const quiet: MobileOverview = { ...baseOverview, agentStatuses: [] };
    expect(buildProjectOverview(quiet, "project-termloop-next").agents[0]?.stateLabel).toBe("Active");
  });

  it("orders agents loudest first, then by most recent observation", () => {
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: [
        session({ id: "ses_working_old" }),
        session({ id: "ses_waiting" }),
        session({ id: "ses_working_new" }),
      ],
      agentStatuses: [
        status({ sessionId: "ses_working_old", status: "working", observedAtEpochMs: now - 600_000 }),
        status({ sessionId: "ses_waiting", status: "awaitingInput", observedAtEpochMs: now - 60_000 }),
        status({ sessionId: "ses_working_new", status: "working", observedAtEpochMs: now - 5_000 }),
      ],
    };
    const model = buildProjectOverview(overview, "project-termloop-next");
    expect(model.agents.map((row) => row.sessionId)).toEqual([
      "ses_waiting",
      "ses_working_new",
      "ses_working_old",
    ]);
  });

  it("nests every Ask-To helper under its exact source without a two-row limit", () => {
    const source = session({ id: "ses_source", ask_to_source_session_id: null });
    const helpers = [1, 2, 3].map((index) => session({
      id: `ses_helper_${index}`,
      ask_to_source_session_id: source.id,
    }));
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: [...helpers, source],
      agentStatuses: [],
    };

    const [cluster] = buildProjectOverview(overview, source.project_id).agentClusters;
    expect(cluster?.groups).toHaveLength(1);
    expect(cluster?.groups[0]?.source.sessionId).toBe(source.id);
    expect(cluster?.groups[0]?.helpers.map((row) => row.sessionId)).toEqual(
      helpers.map((helper) => helper.id),
    );
  });

  it("keeps every member and name of a desktop-authored peer group", () => {
    const agents = [1, 2, 3, 4].map((index) => session({ id: `ses_group_${index}` }));
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: agents,
      agentStatuses: [],
      agentGroupsByProject: {
        [agents[0]!.project_id]: [{
          sessionIds: agents.map((agent) => agent.id),
          name: "Review crew",
        }],
      },
    };

    const [cluster] = buildProjectOverview(overview, agents[0]!.project_id).agentClusters;
    expect(cluster?.manualGroup?.name).toBe("Review crew");
    expect(cluster?.groups.flatMap(({ source, helpers }) => [source, ...helpers])
      .map((row) => row.sessionId)).toEqual(agents.map((agent) => agent.id));
  });

  it("separates terminals from agents and keeps stopped Agents reachable for recovery", () => {
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: [
        session({ id: "ses_term", kind: "Terminal", name: null, process: { ...session({}).process, program: "/bin/zsh", agent_id: null } }),
        session({ id: "ses_gone", lifecycle_state: "exited" }),
      ],
      agentStatuses: [],
    };
    const model = buildProjectOverview(overview, "project-termloop-next");
    expect(model.terminals.map((row) => row.sessionId)).toEqual(["ses_term"]);
    expect(model.agents.map((row) => row.sessionId)).toEqual(["ses_gone"]);
    expect(model.agents[0]).toMatchObject({
      attachable: false,
      state: { id: "processExited", label: "Exited" },
    });
  });

  it("surfaces a failed provider-history resume as blocked recovery work", () => {
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: [session({
        id: "ses_fix",
        lifecycle_state: "resumeFailed",
        resume_failure_reason: "providerHistoryDamaged",
        retryable: true,
      })],
      agentStatuses: [],
    };

    const model = buildProjectOverview(overview, "project-termloop-next");
    expect(model.agents[0]).toMatchObject({
      sessionId: "ses_fix",
      attachable: false,
      stateLabel: "Retry available",
      tone: "blocked",
    });
    expect(model.needsYou.map((row) => row.sessionId)).toEqual(["ses_fix"]);
  });

  it("excludes persistent assistants from Active Agents regardless of lifecycle", () => {
    const ordinary = session({ id: "ses_ordinary" });
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: [
        ordinary,
        session({
          id: "ses_steward",
          process: { ...ordinary.process, template_ref: "builtin.steward.executor" },
        }),
        session({
          id: "ses_worker",
          lifecycle_state: "exited",
          process: { ...ordinary.process, template_ref: "builtin.worker.executor" },
        }),
        session({
          id: "ses_assistant",
          process: { ...ordinary.process, template_ref: "builtin.assistant.activation" },
        }),
      ],
      agentStatuses: [],
    };

    const model = buildProjectOverview(overview, "project-termloop-next");
    expect(model.agents.map((row) => row.sessionId)).toEqual(["ses_ordinary"]);
    expect(model.counts.agents).toBe(1);
  });

  it("never prints a terminal's folder twice", () => {
    /// An unnamed terminal is titled by its own folder, so the state line has to say
    /// something else. It used to repeat the title verbatim, which on a long worktree
    /// name filled the row with the same string wrapped over three lines.
    const cwd = "/Users/demo/Projects/termloop-define-termloop-next-mobile-app-feature-9e1456ff_worktree";
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: [session({
        id: "ses_term",
        kind: "Terminal",
        name: null,
        process: { ...session({}).process, program: "/bin/zsh", agent_id: null, cwd },
      })],
      agentStatuses: [],
    };
    const row = buildProjectOverview(overview, "project-termloop-next").terminals[0];
    expect(row?.detail).toBe("zsh");
    expect(row?.title).not.toBe(row?.detail);
    /// The title is narrowed from the middle, because every worktree in this repo shares
    /// a long prefix and the suffix is what tells them apart.
    expect(row?.title.length).toBeLessThanOrEqual(34);
    expect(row?.title.endsWith("_worktree")).toBe(true);
    /// The full path stays in the accessible name, where there is no width to run out of.
    expect(row?.accessibleName).toContain(cwd);
  });

  it("keeps a named terminal's own name and shows where it runs", () => {
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: [session({
        id: "ses_named",
        kind: "Terminal",
        name: "Build",
        process: { ...session({}).process, program: "/bin/zsh", agent_id: null, cwd: "/Users/demo/Projects/next" },
      })],
      agentStatuses: [],
    };
    expect(buildProjectOverview(overview, "project-termloop-next").terminals[0]?.detail)
      .toBe("zsh · …/Projects/next");
  });

  it("takes a session's Task from that Task's presence projection", () => {
    const model = buildProjectOverview(baseOverview, "project-termloop-next");
    const row = model.agents.find((candidate) => candidate.sessionId === "session-claude");
    expect(row?.taskId).toBe("task-mobile");
    expect(row?.taskTitle).toBe("Build the mobile client foundation");
  });

  it("scopes strictly to one project", () => {
    const overview: MobileOverview = {
      ...baseOverview,
      sessions: [...fixtureSessions, session({ id: "ses_other", project_id: "prj_other" })],
    };
    const model = buildProjectOverview(overview, "project-termloop-next");
    expect(model.agents.map((row) => row.sessionId)).not.toContain("ses_other");
  });

  it("hides closed tasks from the open list", () => {
    const overview: MobileOverview = {
      ...baseOverview,
      tasks: [task({ id: "tsk_closed", status: "closed" })],
    };
    expect(buildProjectOverview(overview, "project-termloop-next").tasks).toHaveLength(0);
  });
});

describe("project summaries", () => {
  it("carries each project's loudest tone and its needs-you count", () => {
    const summaries = buildProjectSummaries(baseOverview);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.tone).toBe("attention");
    expect(summaries[0]?.needsYouCount).toBe(1);
    expect(summaries[0]?.summaryLine).toContain("Needs input");
  });

  it("falls back to counts when nothing is asking", () => {
    const quiet: MobileOverview = { ...baseOverview, agentStatuses: [] };
    const summaries = buildProjectSummaries(quiet);
    expect(summaries[0]?.tone).toBe("quiet");
    expect(summaries[0]?.summaryLine).toBe("1 open task · 1 agent");
  });

  it("agrees with the connection roll-up on how many agents want the user", () => {
    expect(connectionSummaryLine(baseOverview)).toBe("1 project · 1 agent · 1 needs you");
    expect(connectionSummaryLine({ ...baseOverview, agentStatuses: [] })).toBe("1 project · 1 agent");
  });
});

describe("task presentation", () => {
  it("reads a healthy launch-ready worktree as ready and offers no remote action", () => {
    const stage = taskStage(task({}));
    expect(stage.id).toBe("ready");
    expect(stage.tone).toBe("quiet");
    expect(taskRemoteActionNote(stage)).toBeUndefined();
  });

  it("names the Mac as the place to act for every stage a phone cannot fix", () => {
    const missing = task({
      worktree_health: { ...task({}).worktree_health!, path_state: "absent", launch_ready: false },
    });
    const repair = taskStage(missing);
    expect(repair.id).toBe("repair");
    expect(repair.tone).toBe("blocked");
    expect(taskRemoteActionNote(repair)).toContain("on your Mac");

    const none = taskStage(planningTask());
    expect(none.id).toBe("planning");
    expect(taskRemoteActionNote(none)).toContain("on your Mac");
  });

  it("turns a provisioning failure kind into a sentence, and an unknown kind into the generic one", () => {
    const failed = taskStage(task({
      worktree_provisioning: { operation_id: "op_7", status: "failed", failure: { kind: "branchConflict" } },
    }));
    expect(failed.tone).toBe("blocked");
    expect(failed.summary).toContain("Another checkout already has this branch.");
    /// A daemon ahead of this build can put an unheard-of kind on the wire; a blocked
    /// Task must still get an explanation rather than a bare flag.
    expect(provisioningFailureNote(undefined)).toBe("Git refused to create the worktree.");
  });

  it("summarizes the Task in plain language before technical details", () => {
    expect(taskAtAGlance(taskStage(task({})), [])).toMatchObject({
      title: "Ready to start",
      tone: "quiet",
    });
    expect(taskAtAGlance(taskStage(planningTask()), [])).toMatchObject({
      title: "Setup needed",
      detail: expect.stringContaining("workspace"),
    });
  });

  it("puts an Agent that needs the user ahead of workspace state", () => {
    const glance = taskAtAGlance(taskStage(task({})), [{
      title: "Claude",
      stateLabel: "Needs input",
      tone: "attention",
    }]);
    expect(glance).toEqual({
      title: "Claude: Needs input",
      detail: "Open the agent below to review its work or answer it.",
      tone: "attention",
    });
  });

  it("states cleanliness and upstream position on one branch line", () => {
    expect(taskBranchNote(task({}))).toBe("4 changes · no upstream configured");
    expect(taskChangeLabel(1)).toBe("1 change");
  });
});

describe("connection presentation", () => {
  it("forces fresh transports after foregrounding even when background never rendered", () => {
    const active = { active: true, foregroundRevision: 3 };

    expect(shouldResetConnectionTransports(active, active)).toBe(false);
    expect(shouldResetConnectionTransports(active, {
      active: false,
      foregroundRevision: 3,
    })).toBe(true);
    expect(shouldResetConnectionTransports(active, {
      active: true,
      foregroundRevision: 4,
    })).toBe(true);
  });

  it("blocks every availability that cannot be read, and only those", () => {
    expect(connectionPresentation("online").block).toBeUndefined();
    expect(connectionPresentation("reconnecting")).toMatchObject({
      dot: "connecting",
      block: undefined,
    });
    expect(connectionPresentation("offline").block).toBe("offline");
    expect(connectionPresentation("revoked").block).toBe("revoked");
    expect(connectionPresentation("gatewayUpdateRequired").block).toBe("gatewayUpdateRequired");
    expect(connectionPresentation("updateRequired").block).toBe("updateRequired");
  });

  it("directs a stale persistent gateway back to the Mac", () => {
    const copy = connectionBlockCopy("gatewayUpdateRequired");
    expect(`${copy.body} ${copy.resolution}`).toContain("gateway");
    expect(copy.resolution).toContain("open TermLoop on your Mac");
  });

  it("never offers a way past a contract mismatch", () => {
    const copy = connectionBlockCopy("updateRequired");
    expect(copy.resolution).toBe("Update TermLoop Mobile, then reconnect.");
    const words = `${copy.title} ${copy.body} ${copy.resolution}`.toLowerCase();
    expect(words).not.toContain("anyway");
    expect(words).not.toContain("ignore");
  });

  it("keeps a saved Mac selected and its last projection visible through a transient outage", () => {
    const offline: ConnectionProfile = {
      ...mac("offline-mac", "Offline Mac"),
      availability: "offline",
      lastConnectedAtEpochMs: 200,
    };
    expect(preferredConnectionId([offline])).toBe("offline-mac");

    const previous = {
      load: "failed" as const,
      error: "request timeout",
      overview: baseOverview,
      refreshing: true,
      reviewReadySessionIds: new Set<string>(),
      readAtEpochMs: 100,
    };
    expect(snapshotWhileUnavailable("offline", previous)).toMatchObject({
      load: "ready",
      error: undefined,
      overview: previous.overview,
      refreshing: false,
      readAtEpochMs: 100,
    });
    expect(snapshotWhileUnavailable("revoked", previous).overview).toBeUndefined();
  });

  it("settles a visible overview refresh when the app moves to the background", () => {
    const refreshing = {
      load: "ready" as const,
      error: undefined,
      overview: baseOverview,
      refreshing: true,
      reviewReadySessionIds: new Set<string>(),
      readAtEpochMs: 100,
    };

    expect(snapshotWhileBackgrounded(refreshing)).toEqual({
      ...refreshing,
      refreshing: false,
    });
    expect(snapshotWhileBackgrounded(undefined).refreshing).toBe(false);
  });

  it("shows pull-to-refresh only for an explicit gesture, not foreground recovery", () => {
    const previous = {
      load: "ready" as const,
      error: undefined,
      overview: baseOverview,
      refreshing: false,
      reviewReadySessionIds: new Set<string>(),
      readAtEpochMs: 100,
    };

    expect(refreshIndicatorForOverviewRead(true, previous)).toBe(true);
    expect(refreshIndicatorForOverviewRead(false, previous)).toBe(false);
    expect(refreshIndicatorForOverviewRead(true, undefined)).toBe(false);
  });

  it("keeps every paired Mac as its own selector group and carries its identity into retained routes", () => {
    const home = mac("mac-home", "Home Mac");
    const offline = { ...mac("mac-away", "Away Mac"), availability: "offline" as const };
    const located = buildLocatedProjectSummaries([{ connection: home, overview: baseOverview }]);

    expect(projectSelectorGroups([home, offline], located).map((group) => ({
      connectionId: group.connection.id,
      projectCount: group.projects.length,
    }))).toEqual([
      { connectionId: "mac-home", projectCount: baseOverview.projects.length },
      { connectionId: "mac-away", projectCount: 0 },
    ]);
    expect(connectionRouteParams("mac-away", { sessionId: "session-1" })).toEqual({
      sessionId: "session-1",
      connectionId: "mac-away",
    });
  });

  it("recovers a retained Session route from a stale Mac hint using the live projection", () => {
    const scopes = [
      { connectionId: "mac-home", sessionIds: ["session-other"] },
      { connectionId: "mac-away", sessionIds: ["session-target"] },
    ];

    expect(resolveSessionRouteConnectionId("mac-removed", "session-target", scopes))
      .toBe("mac-away");
    expect(resolveSessionRouteConnectionId("mac-removed", "session-missing", scopes))
      .toBeUndefined();
    expect(resolveSessionRouteConnectionId("mac-home", "session-missing", scopes))
      .toBe("mac-home");
  });

  it("never leaves failed or blocked Session routes in a loading state", () => {
    const base = {
      catalogLoad: "ready" as const,
      selectingConnection: false,
      targetConnectionSelected: true,
      targetConnectionReadable: true,
      overviewLoad: "ready" as const,
      unresolvedProjectionsPending: false,
      unresolvedProjectionFailed: false,
    };

    expect(missingSessionRouteState({ ...base, overviewLoad: "failed" })).toBe("overviewFailed");
    expect(missingSessionRouteState({ ...base, targetConnectionReadable: false })).toBe("connectionBlocked");
    expect(missingSessionRouteState({
      ...base,
      targetConnectionSelected: false,
      unresolvedProjectionFailed: true,
    })).toBe("overviewFailed");
    expect(missingSessionRouteState({ ...base, overviewLoad: "loading" })).toBe("loading");
  });

  it("shortens a contract identity while keeping enough to compare two of them", () => {
    expect(shortContractIdentity("sha256:aa13d6ddb30f140eebb79c597b0aae236e0cb1311609cc4bb56019e09ff46677"))
      .toBe("sha256:aa13d6dd…");
    expect(shortContractIdentity("opaque")).toBe("opaque…");
  });
});

describe("path narrowing", () => {
  it("keeps the tail of a path, because the head is what every candidate shares", () => {
    expect(shortenPath("/Users/demo/Projects/termloop-next")).toBe("…/Projects/termloop-next");
    /// Already short enough to be its own answer.
    expect(shortenPath("/Users/demo")).toBe("/Users/demo");
  });

  it("narrows one long segment from the middle so both ends survive", () => {
    const long = "termloop-define-termloop-next-mobile-app-feature-9e1456ff_worktree";
    const short = ellipsizeMiddle(long);
    expect(short.length).toBeLessThanOrEqual(34);
    expect(short.startsWith("termloop-")).toBe(true);
    expect(short.endsWith("_worktree")).toBe(true);
    expect(ellipsizeMiddle("short")).toBe("short");
  });
});

describe("relative age", () => {
  it("stays coarse, because a row states staleness rather than an instant", () => {
    expect(relativeAge(now, now)).toBe("now");
    expect(relativeAge(now - 12_000, now)).toBe("12s");
    expect(relativeAge(now - 240_000, now)).toBe("4m");
    expect(relativeAge(now - 3_600_000, now)).toBe("1h");
    expect(relativeAge(now - 172_800_000, now)).toBe("2d");
  });

  it("never reports a future observation as negative", () => {
    expect(relativeAge(now + 5_000, now)).toBe("now");
  });

  it("says so when a Mac has never been reached", () => {
    expect(relativeAgeSentence(null, now)).toBe("never connected");
    expect(relativeAgeSentence(now - 240_000, now)).toBe("4m ago");
  });
});
