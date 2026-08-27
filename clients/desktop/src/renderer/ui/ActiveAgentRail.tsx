import { Fragment, useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { AgentGroupLayout } from "../../layout/model.js";
import type { AgentStatus, Session } from "../model.js";
import { basename, isLiveSession, sessionLabel } from "../model.js";
import { agentActivityIsOlder, agentActivityPriority, agentGroupActivityPriority, agentLastKnownActivityAtEpochMs, sessionState } from "../session-presentation.js";
import { isAssistantSession } from "./AssistantRail.js";
import { Icon } from "./Icon.js";
import { SessionRowButton, SessionRowClose, sessionRelationshipLabel } from "./SessionRow.js";
import { AgentPlanDisclosure } from "./AgentPlanDisclosure.js";
import { taskChangeLabel } from "../task-presentation.js";
import { AgentGroupFrame, agentSessionClusterMembers, agentSessionClusters, type AgentSessionCluster } from "./AgentGroup.js";
import { useOptionalSidebarSessionDnd } from "./SidebarSessionDnd.js";

export type ActiveAgentSections = {
  actionNeeded: readonly Session[];
  interrupted: readonly Session[];
  inProgress: readonly Session[];
  resting: readonly Session[];
  older: readonly Session[];
  /// Every Agent whose lifecycle is no longer running: a failed resume, an
  /// exited process, a stale terminal. They stay listed because this rail is
  /// the Project's whole Agent list, and a resume failure that appears nowhere
  /// here is a Session the user cannot retry, relocate, or dismiss from it.
  stopped: readonly Session[];
};

type ActiveAgentGroupSections = {
  actionNeeded: readonly AgentSessionCluster[];
  interrupted: readonly AgentSessionCluster[];
  inProgress: readonly AgentSessionCluster[];
  resting: readonly AgentSessionCluster[];
  older: readonly AgentSessionCluster[];
  stopped: readonly AgentSessionCluster[];
};

type ActiveAgentDetailsState = {
  expandedSessionId: string | undefined;
  selectAgent(sessionId: string): void;
  setExpandedSessionId(sessionId: string | undefined): void;
};

export type ActiveAgentWorktreeChanges = {
  taskId: string;
  taskTitle: string;
  changeCount: number;
};

function activeAgentPriority(
  session: Session,
  statusesById: ReadonlyMap<string, AgentStatus>,
  reviewReadySessionIds: ReadonlySet<string>,
): number {
  return agentActivityPriority(session, statusesById.get(session.id), reviewReadySessionIds.has(session.id));
}

/// Order inside the stopped bucket. A failed resume is still recoverable and
/// still holds a conversation, so it leads; a stale terminal only needs
/// reopening; an exited process is the quietest of the three.
function stoppedAgentOrder(session: Session): number {
  if (session.lifecycle_state === "resumeFailed") return 0;
  if (session.lifecycle_state === "stale") return 1;
  return 2;
}

/// This is a presentation-only projection across the selected Project. It does
/// not change Task ownership or manual Session order. State buckets move only
/// when an agent's state changes. Within each bucket, favorites lead and the
/// remaining Agents follow their last known activity. The bounded client-local
/// activity memory keeps that order when a restart resets live observations.
export function activeAgentSections(
  sessions: readonly Session[],
  statusesById: ReadonlyMap<string, AgentStatus>,
  reviewReadySessionIds: ReadonlySet<string>,
  favoriteSessionIds: ReadonlySet<string> = new Set(),
  nowEpochMs = Date.now(),
  rememberedActivityBySessionId: ReadonlyMap<string, number> = new Map(),
): ActiveAgentSections {
  const needsInput: Session[] = [];
  const needsReview: Session[] = [];
  const interrupted: Session[] = [];
  const inProgress: Session[] = [];
  const resting: Session[] = [];
  const older: Session[] = [];
  const stopped: Session[] = [];
  for (const session of sessions) {
    if (session.kind !== "Agent" || isAssistantSession(session)) continue;
    /// Lifecycle outranks the last observed status, exactly as `sessionState`
    /// reads it: an Agent that stopped is not described by whatever it last
    /// claimed to be doing, and it never re-enters an activity bucket.
    if (!isLiveSession(session)) {
      stopped.push(session);
      continue;
    }
    const state = sessionState(session, statusesById.get(session.id), reviewReadySessionIds.has(session.id));
    if (state.id === "awaitingInput") needsInput.push(session);
    else if (state.id === "review") needsReview.push(session);
    else if (state.id === "failed" || state.id === "interrupted") interrupted.push(session);
    else if (state.id === "working" || state.id === "compacting" || state.id === "resuming") inProgress.push(session);
    else if (agentActivityIsOlder(session, statusesById.get(session.id), nowEpochMs, rememberedActivityBySessionId.get(session.id))) older.push(session);
    else resting.push(session);
  }
  const favoriteOrder = (left: Session, right: Session) =>
    Number(favoriteSessionIds.has(right.id)) - Number(favoriteSessionIds.has(left.id));
  const activityOrder = (left: Session, right: Session) =>
    Math.max(agentLastKnownActivityAtEpochMs(statusesById.get(right.id)), rememberedActivityBySessionId.get(right.id) ?? 0)
      - Math.max(agentLastKnownActivityAtEpochMs(statusesById.get(left.id)), rememberedActivityBySessionId.get(left.id) ?? 0);
  const favoriteThenActivityOrder = (left: Session, right: Session) =>
    favoriteOrder(left, right) || activityOrder(left, right);
  const actionNeeded = [...needsInput, ...needsReview].sort((left, right) =>
    favoriteOrder(left, right)
      || activeAgentPriority(left, statusesById, reviewReadySessionIds)
        - activeAgentPriority(right, statusesById, reviewReadySessionIds)
      || activityOrder(left, right));
  interrupted.sort(favoriteThenActivityOrder);
  inProgress.sort(favoriteThenActivityOrder);
  resting.sort((left, right) => {
    const favoriteDifference = favoriteOrder(left, right);
    if (favoriteDifference !== 0) return favoriteDifference;
    return activityOrder(left, right);
  });
  older.sort((left, right) => {
    const favoriteDifference = favoriteOrder(left, right);
    if (favoriteDifference !== 0) return favoriteDifference;
    const priorityDifference = activeAgentPriority(left, statusesById, reviewReadySessionIds)
      - activeAgentPriority(right, statusesById, reviewReadySessionIds);
    if (priorityDifference !== 0) return priorityDifference;
    return activityOrder(left, right);
  });
  stopped.sort((left, right) => {
    const favoriteDifference = favoriteOrder(left, right);
    if (favoriteDifference !== 0) return favoriteDifference;
    const recoveryDifference = stoppedAgentOrder(left) - stoppedAgentOrder(right);
    if (recoveryDifference !== 0) return recoveryDifference;
    return activityOrder(left, right);
  });
  return { actionNeeded, interrupted, inProgress, resting, older, stopped };
}

function activeAgentGroupSections(
  sessions: readonly Session[],
  statusesById: ReadonlyMap<string, AgentStatus>,
  reviewReadySessionIds: ReadonlySet<string>,
  favoriteSessionIds: ReadonlySet<string>,
  nowEpochMs: number,
  manualGroups: readonly AgentGroupLayout[] = [],
  detachedRelationshipSessionIds: ReadonlySet<string> = new Set(),
  rememberedActivityBySessionId: ReadonlyMap<string, number> = new Map(),
): ActiveAgentGroupSections {
  /// Every ordinary Project Agent, running or not. Clustering stays over the
  /// whole set so an Ask-To helper keeps its exact projected source even when
  /// one of the two has stopped.
  const projectAgents = sessions.filter(
    (session) => session.kind === "Agent" && !isAssistantSession(session),
  );
  const needsInput: AgentSessionCluster[] = [];
  const needsReview: AgentSessionCluster[] = [];
  const interrupted: AgentSessionCluster[] = [];
  const inProgress: AgentSessionCluster[] = [];
  const resting: AgentSessionCluster[] = [];
  const older: AgentSessionCluster[] = [];
  const stopped: AgentSessionCluster[] = [];

  for (const group of agentSessionClusters(projectAgents, manualGroups, detachedRelationshipSessionIds)) {
    const members = agentSessionClusterMembers(group);
    /// A cluster is ranked by the members that can still be doing something.
    /// It is stopped only when none of them is live; a stopped member never
    /// quietens a group whose source is still working.
    const liveMembers = members.filter((session) => isLiveSession(session));
    if (liveMembers.length === 0) {
      stopped.push(group);
      continue;
    }
    const priority = agentGroupActivityPriority(liveMembers, statusesById, reviewReadySessionIds);
    if (priority === 0) needsInput.push(group);
    else if (priority === 1) needsReview.push(group);
    else if (priority === 2) interrupted.push(group);
    else if (priority === 3) inProgress.push(group);
    else if (priority >= 4 && liveMembers.every((session) => agentActivityIsOlder(session, statusesById.get(session.id), nowEpochMs, rememberedActivityBySessionId.get(session.id)))) older.push(group);
    else resting.push(group);
  }

  const latestObservation = (group: AgentSessionCluster) => Math.max(
    ...agentSessionClusterMembers(group).map(
      (session) => Math.max(
        agentLastKnownActivityAtEpochMs(statusesById.get(session.id)),
        rememberedActivityBySessionId.get(session.id) ?? 0,
      ),
    ),
  );
  const favoriteOrder = (left: AgentSessionCluster, right: AgentSessionCluster) => {
    const isFavorite = (group: AgentSessionCluster) =>
      agentSessionClusterMembers(group).some((session) => favoriteSessionIds.has(session.id));
    return Number(isFavorite(right)) - Number(isFavorite(left));
  };
  const activityOrder = (left: AgentSessionCluster, right: AgentSessionCluster) =>
    latestObservation(right) - latestObservation(left);
  const favoriteThenActivityOrder = (left: AgentSessionCluster, right: AgentSessionCluster) =>
    favoriteOrder(left, right) || activityOrder(left, right);
  const actionNeeded = [...needsInput, ...needsReview].sort((left, right) =>
    favoriteOrder(left, right)
      || agentGroupActivityPriority(agentSessionClusterMembers(left), statusesById, reviewReadySessionIds)
        - agentGroupActivityPriority(agentSessionClusterMembers(right), statusesById, reviewReadySessionIds)
      || activityOrder(left, right));
  interrupted.sort(favoriteThenActivityOrder);
  inProgress.sort(favoriteThenActivityOrder);
  resting.sort((left, right) => favoriteOrder(left, right) || latestObservation(right) - latestObservation(left));
  older.sort((left, right) => {
    const favoriteDifference = favoriteOrder(left, right);
    if (favoriteDifference !== 0) return favoriteDifference;
    const leftPriority = agentGroupActivityPriority(agentSessionClusterMembers(left), statusesById, reviewReadySessionIds);
    const rightPriority = agentGroupActivityPriority(agentSessionClusterMembers(right), statusesById, reviewReadySessionIds);
    return leftPriority - rightPriority || latestObservation(right) - latestObservation(left);
  });
  stopped.sort((left, right) => {
    const favoriteDifference = favoriteOrder(left, right);
    if (favoriteDifference !== 0) return favoriteDifference;
    const recoveryOrder = (group: AgentSessionCluster) => Math.min(
      ...agentSessionClusterMembers(group).map(stoppedAgentOrder),
    );
    return recoveryOrder(left) - recoveryOrder(right) || latestObservation(right) - latestObservation(left);
  });
  return { actionNeeded, interrupted, inProgress, resting, older, stopped };
}

/// Search matches what a row already displays: the visible label and the
/// worktree folder name. It never re-buckets, re-orders, or splits an Ask-To
/// group; a group stays whole when any member matches so helpers keep their
/// exact projected source.
export function activeAgentQueryMatches(session: Session, normalizedQuery: string): boolean {
  return sessionLabel(session).toLowerCase().includes(normalizedQuery)
    || basename(session.process.cwd).toLowerCase().includes(normalizedQuery);
}

function filterActiveAgentGroupSections(sections: ActiveAgentGroupSections, query: string): ActiveAgentGroupSections {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sections;
  const matching = (groups: readonly AgentSessionCluster[]) => groups.filter(
    (group) => agentSessionClusterMembers(group).some((session) => activeAgentQueryMatches(session, normalized)),
  );
  return {
    actionNeeded: matching(sections.actionNeeded),
    interrupted: matching(sections.interrupted),
    inProgress: matching(sections.inProgress),
    resting: matching(sections.resting),
    older: matching(sections.older),
    stopped: matching(sections.stopped),
  };
}

function flattenGroupSections(sections: ActiveAgentGroupSections): Session[] {
  return [...sections.actionNeeded, ...sections.interrupted, ...sections.inProgress, ...sections.resting, ...sections.older, ...sections.stopped]
    .flatMap(agentSessionClusterMembers);
}

export type ActiveAgentRailProps = {
  sessions: readonly Session[];
  projectFolder: string | undefined;
  selectedSession: Session | undefined;
  visibleSessionIds: ReadonlySet<string>;
  statusesById: ReadonlyMap<string, AgentStatus>;
  rememberedActivityBySessionId?: ReadonlyMap<string, number> | undefined;
  reviewReadySessionIds: ReadonlySet<string>;
  favoriteSessionIds: ReadonlySet<string>;
  taskAttachedSessionIds: ReadonlySet<string>;
  worktreeChangesBySessionId: ReadonlyMap<string, ActiveAgentWorktreeChanges>;
  agentGroups?: readonly AgentGroupLayout[] | undefined;
  detachedRelationshipSessionIds?: ReadonlySet<string> | undefined;
  detachRelationship?: ((sessionId: string) => void) | undefined;
  renameAgentGroup?: ((sessionId: string, name: string) => void) | undefined;
  ungroupAgentGroup?: ((sessionId: string) => void) | undefined;
  menuSessionId: string | undefined;
  selectSession(sessionId: string): void;
  navigateSession(sessionId: string): void;
  openSessionMenu(sessionId: string, x: number, y: number, invoker: HTMLElement): void;
  dismissSession(sessionId: string): void;
  resumeSession(sessionId: string): void;
  archiveSession(sessionId: string): void;
  toggleFavoriteSession(sessionId: string): void;
  openTaskChanges(taskId: string): void;
  /// Opens Quick Action, the same surface the Shift Shift chord reaches. Only
  /// the first-run empty state calls it; every other row here already exists.
  openQuickAction?: (() => void) | undefined;
  /// The search box is controlled from the Shell's tab bar: the rail has no
  /// title row left to carry its toggle, so the Shell owns whether search is
  /// open and the rail owns only the query typed into it.
  searchOpen: boolean;
  setSearchOpen(open: boolean): void;
  nowEpochMs?: number | undefined;
};

export function ActiveAgentRail(props: ActiveAgentRailProps) {
  // Search state is local to this rail so typing re-renders only the rail
  // subtree, never the Shell, transports, or terminal panes.
  const searchOpen = props.searchOpen;
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!props.searchOpen) setQuery("");
  }, [props.searchOpen]);
  const [expandedSessionId, setExpandedSessionId] = useState<string | undefined>(undefined);
  const [clockNowEpochMs, setClockNowEpochMs] = useState(Date.now);
  useEffect(() => {
    if (props.nowEpochMs !== undefined) return;
    const handle = window.setInterval(() => setClockNowEpochMs(Date.now()), 60_000);
    return () => window.clearInterval(handle);
  }, [props.nowEpochMs]);
  const nowEpochMs = props.nowEpochMs ?? clockNowEpochMs;
  const naturalSections = useMemo(
    () => activeAgentGroupSections(props.sessions, props.statusesById, props.reviewReadySessionIds, props.favoriteSessionIds, nowEpochMs, props.agentGroups, props.detachedRelationshipSessionIds, props.rememberedActivityBySessionId),
    [nowEpochMs, props.agentGroups, props.detachedRelationshipSessionIds, props.favoriteSessionIds, props.rememberedActivityBySessionId, props.reviewReadySessionIds, props.sessions, props.statusesById],
  );
  /// The selected row follows the current state immediately. Focus and the
  /// terminal stage remain stable; keeping a row under a stale section label
  /// would make the rail contradict the status it renders.
  const sections = naturalSections;
  useEffect(() => {
    if (expandedSessionId && expandedSessionId !== props.selectedSession?.id) setExpandedSessionId(undefined);
  }, [expandedSessionId, props.selectedSession?.id]);
  const allOrdered = useMemo(() => flattenGroupSections(sections), [sections]);
  const visibleSections = useMemo(() => filterActiveAgentGroupSections(sections, query), [sections, query]);
  const filtering = visibleSections !== sections;
  const ordered = useMemo(
    () => (filtering ? flattenGroupSections(visibleSections) : allOrdered),
    [allOrdered, filtering, visibleSections],
  );
  const sessionsById = useMemo(
    () => new Map(props.sessions.map((session) => [session.id, session])),
    [props.sessions],
  );
  const closeSearch = () => {
    props.setSearchOpen(false);
    setQuery("");
  };
  const selectAgent = (sessionId: string) => {
    setExpandedSessionId((current) => sessionId === props.selectedSession?.id
      ? (current === sessionId ? undefined : sessionId)
      : undefined);
    props.selectSession(sessionId);
  };
  const details: ActiveAgentDetailsState = { expandedSessionId, selectAgent, setExpandedSessionId };
  const navigateAgents = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".active-agent-search")) return;
    if (!(event.key === "ArrowDown" || event.key === "ArrowUp") || ordered.length === 0) return;
    event.preventDefault();
    const selectedIndex = ordered.findIndex((session) => session.id === props.selectedSession?.id);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = selectedIndex < 0
      ? (direction > 0 ? 0 : ordered.length - 1)
      : (selectedIndex + direction + ordered.length) % ordered.length;
    const next = ordered[nextIndex];
    if (!next) return;
    props.navigateSession(next.id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-session-id="${next.id}"]`)?.focus());
  };

  return (
    <nav className="active-agent-rail" aria-label="All active agents" onKeyDown={navigateAgents}>
      {searchOpen ? (
        <div className="active-agent-search">
          <input
            type="search"
            value={query}
            placeholder="Search agents"
            aria-label="Search active agents"
            autoFocus
            spellCheck={false}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              closeSearch();
            }}
          />
        </div>
      ) : null}
      {/* Nothing has ever run here, so the state buckets would print five
          empty labels and teach nothing. The rail says what it is for and
          hands over the chord that opens Quick Action, which is the only way
          in that no button on this view shows. A search that matched nothing
          keeps the ordinary bucket line instead: those agents exist. */}
      {allOrdered.length === 0 && !filtering ? (
        <div className="agent-empty">
          <p className="agent-empty-copy">Every Claude or Codex Session you start in this Project appears here, sorted by who is waiting on you.</p>
          {props.openQuickAction ? (
            <button type="button" className="agent-empty-create" onClick={props.openQuickAction}>
              <Icon name="agent" />Start your first Agent<kbd>Shift Shift</kbd>
            </button>
          ) : null}
          <p className="agent-empty-hint">Tap Shift twice anywhere in TermLoop to open Quick Action, pick an agent, and write its first prompt.</p>
        </div>
      ) : <>
        {visibleSections.actionNeeded.length > 0 ? (
          <ActiveAgentSection label="Action needed" sessions={visibleSections.actionNeeded} props={props} sessionsById={sessionsById} details={details} />
        ) : null}
        {visibleSections.interrupted.length > 0 ? (
          <ActiveAgentSection label="Interrupted" sessions={visibleSections.interrupted} props={props} sessionsById={sessionsById} details={details} />
        ) : null}
        {visibleSections.inProgress.length > 0 ? (
          <ActiveAgentSection label="In progress" sessions={visibleSections.inProgress} props={props} sessionsById={sessionsById} details={details} />
        ) : null}
        <ActiveAgentSection
          label="Idle / paused"
          sessions={visibleSections.resting}
          props={props}
          sessionsById={sessionsById}
          details={details}
          empty={ordered.length === 0}
          emptyLabel={filtering ? "No matching agents" : "None running"}
        />
        {visibleSections.older.length > 0 ? (
          <ActiveAgentSection label="10m+ ago" sessions={visibleSections.older} props={props} sessionsById={sessionsById} details={details} />
        ) : null}
        {/* Last, because nothing here is running — but present, so a failed
            resume, an exited process, and a stale terminal are reachable from
            the rail that claims to hold every Agent in the Project. Each row
            prints its own lifecycle word and keeps its retry and dismiss. */}
        {visibleSections.stopped.length > 0 ? (
          <ActiveAgentSection label="Stopped" sessions={visibleSections.stopped} props={props} sessionsById={sessionsById} details={details} />
        ) : null}
      </>}
    </nav>
  );
}

function ActiveAgentSection({ label, sessions, props, sessionsById, details, empty = false, emptyLabel = "None running" }: {
  label: string;
  sessions: readonly AgentSessionCluster[];
  props: ActiveAgentRailProps;
  sessionsById: ReadonlyMap<string, Session>;
  details: ActiveAgentDetailsState;
  empty?: boolean;
  emptyLabel?: string;
}) {
  if (sessions.length === 0 && !empty) return null;
  const sessionCount = sessions.reduce((count, group) => count + agentSessionClusterMembers(group).length, 0);
  return (
    <section className="active-agent-section" aria-label={label} data-active-agent-section={label}>
      <div className="rail-subhead"><span>{label}</span><span>{sessionCount}</span></div>
      {empty ? <p className="rail-empty">{emptyLabel}</p> : (
        <div className="active-agent-list" role="list">
          {sessions.map((cluster) => (
            <AgentGroupFrame
              key={cluster.key}
              cluster={cluster}
              renameGroup={props.renameAgentGroup}
              ungroup={props.ungroupAgentGroup}
            >
              {cluster.groups.map(({ source, helpers }) => (
                <Fragment key={source.id}>
                  <ActiveAgentRow session={source} props={props} sessionsById={sessionsById} details={details} />
                  {helpers.map((helper) => (
                    <ActiveAgentRow key={helper.id} session={helper} source={source} props={props} sessionsById={sessionsById} details={details} />
                  ))}
                </Fragment>
              ))}
            </AgentGroupFrame>
          ))}
        </div>
      )}
    </section>
  );
}

function ActiveAgentRow({ session, source, props, sessionsById, details }: {
  session: Session;
  source?: Session | undefined;
  props: ActiveAgentRailProps;
  sessionsById: ReadonlyMap<string, Session>;
  details: ActiveAgentDetailsState;
}) {
  const draggable = useDraggable({
    id: `active-agent:${session.id}`,
    data: { kind: "session", sessionId: session.id },
  });
  const sidebarDnd = useOptionalSidebarSessionDnd();
  const droppable = useDroppable({
    id: `active-agent-target:${session.id}`,
    data: { kind: "session", sessionId: session.id },
    disabled: !sidebarDnd,
  });
  const setNodeRef = useCallback((node: HTMLDivElement | null) => {
    draggable.setNodeRef(node);
    droppable.setNodeRef(node);
  }, [draggable.setNodeRef, droppable.setNodeRef]);
  const dropPlacement = sidebarDnd?.sessionDropTarget?.surface !== "group"
    && sidebarDnd?.sessionDropTarget?.sessionId === session.id
    ? sidebarDnd.sessionDropTarget.placement
    : undefined;
  const projectedSource = props.detachedRelationshipSessionIds?.has(session.id) ? undefined : source
    ?? (() => {
      const sourceId = session.ask_to_source_session_id ?? session.fork_source_session_id;
      return sourceId ? sessionsById.get(sourceId) : undefined;
    })();
  const favorite = props.favoriteSessionIds.has(session.id);
  const agentStatus = props.statusesById.get(session.id);
  const reviewReady = props.reviewReadySessionIds.has(session.id);
  const detailsExpanded = details.expandedSessionId === session.id;
  const taskAttached = props.taskAttachedSessionIds.has(session.id)
    || Boolean(projectedSource && props.taskAttachedSessionIds.has(projectedSource.id));
  const worktreeChanges = props.worktreeChangesBySessionId.get(session.id)
    ?? (projectedSource ? props.worktreeChangesBySessionId.get(projectedSource.id) : undefined);
  const row = (
    <div ref={setNodeRef} className="active-agent-entry" role={source ? undefined : "listitem"} data-session-drop-target={session.id}>
      <div className={`session-row active-agent-row${worktreeChanges ? " has-worktree-changes" : ""}${draggable.isDragging ? " dragging" : ""}${dropPlacement ? ` drop-${dropPlacement}` : ""}`}>
        <SessionRowButton
        session={session}
        agentStatus={agentStatus}
        reviewReady={reviewReady}
        subtitle={session.process.cwd === props.projectFolder ? "" : basename(session.process.cwd)}
        {...(projectedSource?.kind === "Agent"
          ? { relationshipLabel: source ? sessionRelationshipLabel(source, session) : sessionRelationshipLabel(projectedSource, session) }
          : {})}
        active={session.id === props.selectedSession?.id}
        visible={props.visibleSessionIds.has(session.id)}
        menuOpen={session.id === props.menuSessionId}
        detailsExpanded={detailsExpanded}
        dragAttributes={draggable.attributes}
        dragListeners={draggable.listeners}
        select={() => details.selectAgent(session.id)}
        openMenu={(x, y, invoker) => props.openSessionMenu(session.id, x, y, invoker)}
        />
        <SessionRowClose
        session={session}
        dismiss={() => props.dismissSession(session.id)}
        resume={() => props.resumeSession(session.id)}
        archive={() => props.archiveSession(session.id)}
        />
        <button
        type="button"
        className={`active-agent-favorite${favorite ? " favorite" : ""}`}
        aria-label={`${favorite ? "Remove" : "Add"} ${sessionLabel(session)} ${favorite ? "from" : "to"} Favs`}
        aria-pressed={favorite}
        title={favorite ? "Remove from Favs" : "Add to Favs"}
        onClick={() => props.toggleFavoriteSession(session.id)}
        ><Icon name="star" /></button>
        {worktreeChanges ? <button
        type="button"
        className="active-agent-worktree-changes"
        aria-label={`Review ${taskChangeLabel(worktreeChanges.changeCount)} in ${worktreeChanges.taskTitle}`}
        title={`Review ${taskChangeLabel(worktreeChanges.changeCount)} in ${worktreeChanges.taskTitle}`}
        onClick={(event) => { event.stopPropagation(); props.openTaskChanges(worktreeChanges.taskId); }}
        >{taskChangeLabel(worktreeChanges.changeCount)}</button> : null}
      </div>
      {agentStatus?.status !== "idle" || reviewReady || detailsExpanded ? <AgentPlanDisclosure
        session={session}
        status={agentStatus}
        selected={session.id === props.selectedSession?.id}
        expanded={detailsExpanded}
        setExpanded={(expanded) => details.setExpandedSessionId(expanded ? session.id : undefined)}
        showWorkspace={taskAttached}
      /> : null}
    </div>
  );
  if (!source) return row;
  return (
    <div className="ask-to-helper compact active-agent-helper" role="listitem">
      {props.detachRelationship ? <button
        type="button"
        className="ask-to-helper-detach"
        aria-label={`Show ${sessionLabel(session)} separately from ${sessionLabel(source)}`}
        title="Show this agent separately"
        onClick={(event) => { event.stopPropagation(); props.detachRelationship?.(session.id); }}
      >×</button> : null}
      <div className="active-agent-helper-row">
        {row}
      </div>
    </div>
  );
}
