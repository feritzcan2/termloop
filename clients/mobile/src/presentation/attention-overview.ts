import type {
  AgentStatusDto,
  ProjectDto,
  SessionDto,
  TaskDto,
} from "@termloop/contract/current";

import type { ConnectionProfile, MobileOverview } from "../application/ports";
import {
  basename,
  ellipsizeMiddle,
  isAssistantSession,
  isLiveSession,
  sessionLabel,
  shortenPath,
  taskIdBySessionId,
} from "./dto-readers";
import {
  agentAttention,
  agentStatusIsLive,
  sessionProvenance,
  sessionRelationship,
  sessionRowAccessibleName,
  sessionState,
  type AgentAttention,
  type SessionState,
} from "./session-presentation";
import {
  taskChangeCount,
  taskChangeLabel,
  taskRowTone,
  taskStage,
  type TaskStage,
} from "./task-presentation";
import { toneRank, type RowTone } from "./tone";

/// Turns one connection-wide projection into the Project overview the phone shows.
///
/// The Project screen presents these projections through peer Agents and Tasks tabs,
/// matching desktop. Attention remains one shared derivation so both tab markers and
/// the ordered rows agree about what currently needs the user.
///
/// Everything here is derived. Task presence, agent attention, and the per-Project
/// summary are projections of Session and Task facts, never stored entities — the
/// retired `ActiveAgentRecord` is exactly the shape this module must not become.

const noReviewReadySessions: ReadonlySet<string> = new Set<string>();

export interface AgentRow {
  readonly sessionId: string;
  readonly title: string;
  readonly agentId: string | null;
  readonly state: SessionState;
  /// Mobile always prints a state. The desktop can leave a settled live row
  /// silent because it is continuously present; a phone opening the overview
  /// late needs an explicit indication that the process is still attachable.
  readonly stateLabel: string;
  readonly tone: RowTone;
  /// Which agent or program drives it, with anything the title already said removed.
  readonly runner: string | undefined;
  readonly folder: string | undefined;
  /// The Task it is attached to, taken from that Task's presence projection.
  readonly taskId: string | undefined;
  readonly taskTitle: string | undefined;
  readonly relationship: string | undefined;
  readonly observedAtEpochMs: number | undefined;
  readonly accessibleName: string;
  readonly attachable: boolean;
}

export interface TaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly tone: RowTone;
  readonly stage: TaskStage;
  readonly attention: AgentAttention | undefined;
  /// The one state line, assembled in the order a glance ranks it.
  readonly stateLine: string;
  readonly accessibleName: string;
}

export interface TerminalRow {
  readonly sessionId: string;
  readonly title: string;
  /// The state line. Never a repeat of the title: an unnamed terminal is already titled
  /// by its own folder, so printing that folder again spends the row's second line on a
  /// string the reader took in one line above.
  readonly detail: string;
  readonly attachable: boolean;
  readonly accessibleName: string;
}

export interface OverviewCounts {
  readonly needsYou: number;
  readonly agents: number;
  readonly tasks: number;
  readonly terminals: number;
}

export interface ProjectOverview {
  readonly project: ProjectDto | undefined;
  /// Agents that are waiting on the user right now. Rendered as its own section only
  /// when non-empty — an empty "Needs you" box is a promise the screen keeps making
  /// and never keeping.
  readonly needsYou: readonly AgentRow[];
  /// Every ordinary Agent descriptor, including stopped recovery states. A failed
  /// resume must remain reachable so the phone can offer the same Fix/Retry action
  /// as desktop instead of silently removing the only way to recover it.
  readonly agents: readonly AgentRow[];
  readonly tasks: readonly TaskRow[];
  readonly terminals: readonly TerminalRow[];
  readonly counts: OverviewCounts;
}

/// A tone is only worth an attention section when it is actually asking for the
/// user. `working` and below are reports, not requests.
function asksForUser(tone: RowTone): boolean {
  return tone === "attention" || tone === "blocked" || tone === "review";
}

/// Loudest first, then most recently observed. Two rows with the same tone are
/// ordered by which one changed last, so a stale blocker never sits above a fresh
/// one purely because of list order.
function byUrgencyThenRecency(left: AgentRow, right: AgentRow): number {
  const tone = toneRank(right.tone) - toneRank(left.tone);
  if (tone !== 0) return tone;
  return (right.observedAtEpochMs ?? 0) - (left.observedAtEpochMs ?? 0);
}

function byTaskUrgencyThenRank(left: TaskRow, right: TaskRow, rankById: ReadonlyMap<string, number>): number {
  const tone = toneRank(right.tone) - toneRank(left.tone);
  if (tone !== 0) return tone;
  return (rankById.get(left.taskId) ?? 0) - (rankById.get(right.taskId) ?? 0);
}

function statusMap(statuses: readonly AgentStatusDto[]): Map<string, AgentStatusDto> {
  const byId = new Map<string, AgentStatusDto>();
  for (const status of statuses) byId.set(status.sessionId, status);
  return byId;
}

function taskStateLine(task: TaskDto, stage: TaskStage, attention: AgentAttention | undefined): string {
  const parts: string[] = [];
  if (attention) parts.push(`${attention.label} · ${attention.agent}`);
  else if (stage.flag) parts.push(stage.flag);
  const presence = task.worktree_presence?.total_count ?? 0;
  if (presence > 0) parts.push(`${presence} ${presence === 1 ? "session" : "sessions"}`);
  const changes = taskChangeCount(task);
  if (changes !== undefined) parts.push(taskChangeLabel(changes));
  if (parts.length === 0) parts.push(stage.id === "ready" ? "Ready" : stage.summary);
  return parts.join(" · ");
}

function buildAgentRow(options: {
  session: SessionDto;
  status: AgentStatusDto | undefined;
  sessionsById: ReadonlyMap<string, SessionDto>;
  taskId: string | undefined;
  taskTitle: string | undefined;
  reviewReadySessionIds: ReadonlySet<string>;
}): AgentRow {
  const { session, status, sessionsById, taskId, taskTitle, reviewReadySessionIds } = options;
  const live = agentStatusIsLive(session) ? status : undefined;
  const state = sessionState(session, live, reviewReadySessionIds.has(session.id));
  const provenance = sessionProvenance(session, basename(session.process.cwd));
  const relationship = sessionRelationship(session, sessionsById);
  const attachable = isLiveSession(session);
  return {
    sessionId: session.id,
    title: sessionLabel(session),
    agentId: session.process.agent_id,
    state,
    stateLabel: state.label ?? (attachable ? "Active" : state.summary),
    tone: state.tone,
    runner: provenance.runner,
    folder: provenance.folder,
    taskId,
    taskTitle,
    relationship,
    observedAtEpochMs: live?.observedAtEpochMs,
    accessibleName: sessionRowAccessibleName({ session, state, relationship }),
    /// Attaching needs a live PTY. An exited or stale Session has no stream to join,
    /// and offering the terminal anyway would open a screen that can only apologise.
    attachable,
  };
}

export function buildProjectOverview(
  overview: MobileOverview,
  projectId: string,
  reviewReadySessionIds: ReadonlySet<string> = noReviewReadySessions,
): ProjectOverview {
  const project = overview.projects.find((candidate) => candidate.id === projectId);
  const tasks = overview.tasks.filter((task) => task.project_id === projectId);
  const sessions = overview.sessions.filter((session) => session.project_id === projectId);
  const statusesById = statusMap(overview.agentStatuses);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const taskBySession = taskIdBySessionId(tasks);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const rankById = new Map(tasks.map((task) => [task.id, task.rank]));

  const agentRows = sessions
    .filter((session) => session.kind === "Agent"
      && !isAssistantSession(session))
    .map((session) => {
      const taskId = taskBySession.get(session.id);
      return buildAgentRow({
        session,
        status: statusesById.get(session.id),
        sessionsById,
        taskId,
        taskTitle: taskId === undefined ? undefined : taskById.get(taskId)?.title,
        reviewReadySessionIds,
      });
    })
    .sort(byUrgencyThenRecency);

  const needsYou = agentRows.filter((row) => asksForUser(row.tone));

  const taskRows = tasks
    .filter((task) => task.status === "open")
    .map((task): TaskRow => {
      const attachedSessions = (task.worktree_presence?.attached_sessions ?? [])
        .map((attached) => sessionsById.get(attached.session_id))
        .filter((session): session is SessionDto => session !== undefined);
      const attention = agentAttention(attachedSessions, statusesById, reviewReadySessionIds);
      const stage = taskStage(task);
      const tone = taskRowTone(stage, attention);
      const stateLine = taskStateLine(task, stage, attention);
      return {
        taskId: task.id,
        title: task.title,
        tone,
        stage,
        attention,
        stateLine,
        accessibleName: `${task.title}, ${stage.summary}${attention ? ` ${attention.agent} ${attention.label.toLowerCase()}.` : ""}`,
      };
    })
    .sort((left, right) => byTaskUrgencyThenRank(left, right, rankById));

  const terminals = sessions
    .filter((session) => session.kind === "Terminal")
    .map((session): TerminalRow => {
      const label = sessionLabel(session);
      const program = basename(session.process.program);
      const folder = basename(session.process.cwd);
      /// The program is the useful second fact for a terminal named after its folder, and
      /// the shortened path is the useful one for a terminal the user named themselves.
      const detail = label === folder
        ? program
        : `${program} · ${shortenPath(session.process.cwd)}`;
      return {
        sessionId: session.id,
        title: ellipsizeMiddle(label),
        detail,
        attachable: isLiveSession(session),
        accessibleName: `${label}, ${program} terminal in ${session.process.cwd}`,
      };
    });

  return {
    project,
    needsYou,
    agents: agentRows,
    tasks: taskRows,
    terminals,
    counts: {
      needsYou: needsYou.length,
      agents: agentRows.length,
      tasks: taskRows.length,
      terminals: terminals.length,
    },
  };
}

/// The Project selector's per-Project line.
///
/// This is the one cross-Project read in the whole client. Every other surface is
/// Project-scoped on purpose, and the selector needs exactly two facts about the
/// Projects the current screen is *not* showing — how loudly each is asking, and how
/// many agents are asking — so it is bounded to those rather than becoming a second
/// overview.
export interface ProjectSummary {
  readonly project: ProjectDto;
  readonly tone: RowTone;
  readonly needsYouCount: number;
  readonly openTaskCount: number;
  /// One short line under the name, so switching Projects does not require guessing.
  readonly summaryLine: string;
}

export function buildProjectSummaries(
  overview: MobileOverview,
  reviewReadySessionIds: ReadonlySet<string> = noReviewReadySessions,
): readonly ProjectSummary[] {
  return overview.projects.map((project): ProjectSummary => {
    const scoped = buildProjectOverview(overview, project.id, reviewReadySessionIds);
    const loudest = scoped.agents.reduce<RowTone>(
      (tone, row) => (toneRank(row.tone) > toneRank(tone) ? row.tone : tone),
      "quiet",
    );
    const needsYouCount = scoped.counts.needsYou;
    const openTaskCount = scoped.counts.tasks;
    const first = scoped.needsYou[0];
    const summaryLine = first
      ? `${first.state.label ?? "Needs you"} · ${first.runner ?? first.title}${first.taskTitle ? ` on ${first.taskTitle}` : ""}`
      : `${openTaskCount} open ${openTaskCount === 1 ? "task" : "tasks"} · ${scoped.counts.agents} ${scoped.counts.agents === 1 ? "agent" : "agents"}`;
    return { project, tone: loudest, needsYouCount, openTaskCount, summaryLine };
  });
}

export interface LocatedProjectOverview {
  readonly connection: ConnectionProfile;
  readonly overview: MobileOverview;
  readonly reviewReadySessionIds?: ReadonlySet<string>;
}

export interface LocatedProjectSummary {
  readonly connection: ConnectionProfile;
  readonly summary: ProjectSummary;
}

/// Flattens several connection-owned projections for presentation only. The owning
/// connection travels with every row, so navigation never treats two Macs as one
/// authority even though Home presents their Projects as one list.
export function buildLocatedProjectSummaries(
  sources: readonly LocatedProjectOverview[],
): readonly LocatedProjectSummary[] {
  return sources.flatMap(({ connection, overview, reviewReadySessionIds }) => (
    buildProjectSummaries(overview, reviewReadySessionIds)
      .map((summary) => ({ connection, summary }))
  ));
}

/// The connection card's one-line roll-up. Same derivation as the selector, summed,
/// so the card and the menu can never disagree about how many agents want the user.
export function connectionSummaryLine(
  overview: MobileOverview,
  reviewReadySessionIds: ReadonlySet<string> = noReviewReadySessions,
): string {
  const summaries = buildProjectSummaries(overview, reviewReadySessionIds);
  const projects = summaries.length;
  const agents = overview.sessions.filter(
    (session) => session.kind === "Agent" && !isAssistantSession(session),
  ).length;
  const needsYou = summaries.reduce((total, summary) => total + summary.needsYouCount, 0);
  const parts = [
    `${projects} ${projects === 1 ? "project" : "projects"}`,
    `${agents} ${agents === 1 ? "agent" : "agents"}`,
  ];
  if (needsYou > 0) parts.push(`${needsYou} needs you`);
  return parts.join(" · ");
}
