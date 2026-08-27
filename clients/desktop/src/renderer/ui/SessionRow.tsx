import { useDraggable, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type Ref } from "react";
import type { SplitDirection } from "../../layout/model.js";
import type { AgentStatus, Session } from "../model.js";
import { sessionDismissCommand, sessionLabel, sessionResumeActionLabel } from "../model.js";
import {
  agentStatusIsLive,
  agentStatusTooltip,
  sessionIsImprover,
  sessionProvenance,
  sessionRowAccessibleName,
  sessionState,
  type SessionState,
} from "../session-presentation.js";
import { Icon, type IconName } from "./Icon.js";

export type SessionMenuState = { sessionId: string; x: number; y: number; invoker: HTMLElement };

export type AskToSessionGroup = {
  source: Session;
  helpers: readonly Session[];
};

export function sessionRelationshipLabel(source: Session, helper: Session): string {
  return helper.fork_source_session_id === source.id
    ? `forked from ${sessionLabel(source)}`
    : `from ${sessionLabel(source)}`;
}

/// Build one presentation-only level from the exact current Ask-To source
/// projection. Missing, malformed, or nested sources degrade to ordinary
/// top-level rows instead of hiding a Session or inventing a relationship.
export function askToSessionGroups(
  sessions: readonly Session[],
  detachedRelationshipSessionIds: ReadonlySet<string> = new Set(),
): AskToSessionGroup[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const helpersBySource = new Map<string, Session[]>();
  const sources: Session[] = [];

  for (const session of sessions) {
    const sourceId = session.ask_to_source_session_id ?? session.fork_source_session_id;
    const source = sourceId ? sessionsById.get(sourceId) : undefined;
    const validRelationship = !detachedRelationshipSessionIds.has(session.id)
      && session.kind === "Agent"
      && source?.kind === "Agent"
      && source.id !== session.id
      && (session.fork_source_session_id === source.id
        || (session.ask_to_source_session_id === source.id && source.ask_to_source_session_id === null));
    if (!validRelationship || !source) {
      sources.push(session);
      continue;
    }
    const helpers = helpersBySource.get(source.id) ?? [];
    helpers.push(session);
    helpersBySource.set(source.id, helpers);
  }

  return sources.map((source) => ({ source, helpers: helpersBySource.get(source.id) ?? [] }));
}

/// Close removes the Session from the user's current surface. Retryable
/// ownership failures are terminated through the daemon's recovery path before
/// their descriptor is removed.
function sessionDismissal(session: Session): { verb: string; hint: string } | undefined {
  const command = sessionDismissCommand(session);
  if (command && session.kind === "Agent") {
    return {
      verb: command === "terminate" ? "Close" : "Remove",
      hint: "Close Agent and keep it in Deleted for 30 days",
    };
  }
  if (command === "terminate") return { verb: "Close", hint: "End and remove this Session" };
  if (command === "close") return { verb: "Remove", hint: "Remove this stopped Session" };
  return undefined;
}

/// The legacy rail hangs a close affordance off the top-right corner of a row
/// and reveals it on hover. Closing from here is immediate by request: the row
/// itself is the confirmation, and the Session menu keeps the same action.
function sessionCanBeArchived(session: Session): boolean {
  const template = session.process.template_ref;
  return session.kind === "Agent"
    && session.lifecycle_state === "running"
    && session.ask_to_source_session_id === null
    && template !== "builtin.agent.ask-to-helper"
    && template !== "builtin.steward.executor"
    && template !== "builtin.worker.executor";
}

export function SessionRowClose({ session, dismiss, archive, resume }: { session: Session; dismiss(): void; archive?: (() => void) | undefined; resume?: (() => void) | undefined }) {
  const dismissal = sessionDismissal(session);
  const archivable = archive && sessionCanBeArchived(session);
  const resumeAction = resume;
  const fixesProviderHistory = Boolean(
    resumeAction
      && session.kind === "Agent"
      && session.resume_failure_reason === "providerHistoryDamaged",
  );
  const resumeLabel = fixesProviderHistory
    ? "Fix"
    : resumeAction ? sessionResumeActionLabel(session) : undefined;
  if (!dismissal && !archivable && !resumeLabel) return null;
  return (
    <div className="row-actions">
      {archivable ? (
        <button
          type="button"
          className="row-action archive-action"
          aria-label={`Archive ${sessionLabel(session)}`}
          title="Archive Agent and preserve its resumable context"
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); archive(); }}
        ><Icon name="archive" /></button>
      ) : null}
      {resumeLabel ? (
        <button
          type="button"
          className="row-action retry-action"
          aria-label={`${resumeLabel} ${sessionLabel(session)}`}
          title={fixesProviderHistory ? "Repair provider history and retry Agent" : `${resumeLabel} Agent`}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); resumeAction?.(); }}
        >{resumeLabel}</button>
      ) : null}
      {dismissal ? (
        <button
          type="button"
          className="row-action"
          aria-label={`${dismissal.verb} ${sessionLabel(session)}`}
          title={dismissal.hint}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); dismiss(); }}
        ><Icon name="close" /></button>
      ) : null}
    </div>
  );
}

/// The row shared by the Project Session sections and the Sessions nested under
/// a Task. Presentation only — the caller owns selection, ordering, and the
/// context menu it opens.
export function SessionRowButton({ session, agentStatus, reviewReady = false, subtitle, relationshipLabel, active, visible, menuOpen, detailsExpanded = false, runCommand, dragAttributes, dragListeners, select, openMenu }: {
  session: Session;
  agentStatus: AgentStatus | undefined;
  reviewReady?: boolean;
  subtitle: string;
  relationshipLabel?: string;
  active: boolean;
  visible: boolean;
  menuOpen: boolean;
  detailsExpanded?: boolean;
  dragAttributes?: DraggableAttributes;
  dragListeners?: DraggableSyntheticListeners;
  /// The command behind a run, which is what that row is actually about. Absent
  /// for every Session that is not a run.
  runCommand?: string | undefined;
  select(): void;
  openMenu(x: number, y: number, invoker: HTMLElement): void;
}) {
  const state = sessionState(session, agentStatus, reviewReady);
  /// The presence dot reports the raw observed agent status, so it must go quiet
  /// once the lifecycle has moved on and that observation is stale.
  const liveAgentStatus = agentStatusIsLive(session) ? agentStatus : undefined;
  return (
    <button
      className={`session-item ${session.kind === "Agent" ? "agent" : "terminal"}${session.run_configuration_id ? " run" : ""}${sessionIsImprover(session) ? " improver" : ""}${active ? " active" : ""}${visible ? " visible" : ""}${detailsExpanded ? " details-expanded" : ""} state-${state.tone}`}
      type="button"
      {...dragAttributes}
      aria-label={sessionRowAccessibleName({ session, state, relationship: relationshipLabel })}
      aria-pressed={active}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      data-session-id={session.id}
      onPointerDown={(event) => { dragListeners?.onPointerDown?.(event); }}
      title={session.process.cwd}
      onClick={select}
      onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu(rect.left + 28, rect.top + rect.height / 2, event.currentTarget);
      }}
    >
      <SessionRowContent session={session} agentStatus={liveAgentStatus} state={state} reviewReady={reviewReady} subtitle={subtitle} visible={visible} active={active} runCommand={runCommand} />
    </button>
  );
}

export function AskToHelperRow({ source, helper, agentStatus, reviewReady = false, subtitle, relationshipLabel, active, visible, menuOpen, detailsExpanded = false, compact = false, relocatable = false, select, openMenu, dismiss, resume, detachRelationship }: {
  source: Session;
  helper: Session;
  agentStatus: AgentStatus | undefined;
  reviewReady?: boolean;
  subtitle: string;
  relationshipLabel?: string;
  active: boolean;
  visible: boolean;
  menuOpen: boolean;
  detailsExpanded?: boolean;
  compact?: boolean;
  relocatable?: boolean;
  select(): void;
  openMenu(x: number, y: number, invoker: HTMLElement): void;
  dismiss(): void;
  resume?(): void;
  detachRelationship?(): void;
}) {
  const sourceLabel = relationshipLabel ?? sessionRelationshipLabel(source, helper);
  const draggable = useDraggable({
    id: `task-session:${helper.id}`,
    data: { kind: "session", sessionId: helper.id },
    disabled: !relocatable,
  });
  return (
    <div ref={draggable.setNodeRef} className={`ask-to-helper${compact ? " compact" : ""}${draggable.isDragging ? " dragging" : ""}`} role="listitem">
      {detachRelationship ? <button
        type="button"
        className="ask-to-helper-detach"
        aria-label={`Show ${sessionLabel(helper)} separately from ${sessionLabel(source)}`}
        title="Show this agent separately"
        onClick={(event) => { event.stopPropagation(); detachRelationship(); }}
      >×</button> : null}
      {/* The relationship is carried by the elbow connector and the row's
          accessible name; a visible "from X" line directly under the source
          row it names only repeats what the nesting already says. */}
      {/* The drag handle occupies its own grid column; without the matching
          class the two-column template wraps the row content into a broken
          stack, so the class and the handle must appear together. */}
      <div className={`session-row ask-to-helper-row${compact ? " task-session" : ""}${relocatable ? " with-drag-handle" : ""}`}>
        <span className="ask-to-helper-connector" aria-hidden="true" />
        {relocatable ? <button
          className="session-drag-handle"
          type="button"
          aria-label={`Move ${sessionLabel(helper)}`}
          {...draggable.attributes}
          {...draggable.listeners}
          onClick={(event) => event.stopPropagation()}
        ><Icon name="grip" /></button> : null}
        <SessionRowButton
          session={helper}
          agentStatus={agentStatus}
          reviewReady={reviewReady}
          subtitle={subtitle}
          relationshipLabel={sourceLabel}
          active={active}
          visible={visible}
          menuOpen={menuOpen}
          detailsExpanded={detailsExpanded}
          {...(relocatable ? {
            dragAttributes: draggable.attributes,
            dragListeners: draggable.listeners,
          } : {})}
          select={select}
          openMenu={openMenu}
        />
        <SessionRowClose session={helper} dismiss={dismiss} resume={resume} />
      </div>
    </div>
  );
}

/// A Session row is the same two zones as a Task row: an identity zone that says
/// who this is, and one state line that holds everything TermLoop observed. The
/// state line reads left to right in descending urgency — what it is doing, what
/// is driving it, where it runs — and its left edge never moves, so the state word
/// stays in the place the eye already knows instead of being pushed around by the
/// length of a folder name the way the old right-aligned tail was.
///
/// The identity zone uses the UI face because a Session name is something a person
/// wrote and can rename; the observed facts below it stay monospace and truncate
/// first. Exactly one `<strong>` lives in the row, holding exactly the Session
/// label — `tests/e2e/f1/session-navigation.mjs` reads the renamed label through
/// it, so a second one would break that assertion.
function SessionRowContent({ session, agentStatus, state, reviewReady, subtitle, visible, active, runCommand }: {
  session: Session;
  agentStatus: AgentStatus | undefined;
  state: SessionState;
  reviewReady: boolean;
  subtitle: string;
  visible: boolean;
  active: boolean;
  runCommand?: string | undefined;
}) {
  const provenance = sessionProvenance(session, subtitle);
  /// A run is a service the Project starts, not a conversation or a shell the
  /// user is typing in. It is named by its configuration and described by the
  /// command it runs, so the runner ("zsh") and the folder — the two facts a
  /// terminal row exists to state — are the wrong ones here.
  const run = Boolean(session.run_configuration_id);
  /// Same reasoning as a run: an improver is named by the thing it is working
  /// on, so repeating "Claude" costs the row's narrowest line a word the title
  /// already carried.
  const improver = sessionIsImprover(session);
  const runner = run || improver ? undefined : provenance.runner;
  return (
    <>
      <i className={`row-rail ${state.tone}`} aria-hidden="true" />
      <span className="session-presence">
        {run ? (
          <span className="run-badge" title={state.summary}><Icon name="play" /></span>
        ) : improver ? (
          <span className="improve-badge" title={state.summary}><Icon name="sparkles" /></span>
        ) : (
          <span
            className={`live-dot${agentStatus ? ` agent-status-${reviewReady ? "readyForReview" : agentStatus.status}` : ""}`}
            /// Without a live observation the dot falls back to the row's own state
            /// rather than to a flat "Running", which was untrue on exactly the rows
            /// that had stopped.
            title={agentStatus ? agentStatusTooltip(agentStatus, reviewReady) : state.summary}
          />
        )}
      </span>
      <span className="row-copy">
        <strong className="row-title">{sessionLabel(session)}</strong>
        <span className="session-state-line">
          {run ? <span className="row-run-kind">Run</span> : null}
          {improver ? <span className="row-improve-kind">Improver</span> : null}
          {state.label ? <em className={`row-state ${state.tone}`} title={state.summary}>{state.label}</em> : null}
          {runner ? <span className={`row-agent${session.process.agent_id ? ` agent-${session.process.agent_id}` : ""}`}>{runner}</span> : null}
          {run && runCommand
            ? <code className="row-run-command" title={runCommand}>{runCommand}</code>
            : provenance.folder ? <small className="row-subtitle" title={session.process.cwd}>{provenance.folder}</small> : null}
        </span>
      </span>
      <span className="session-presence">{visible ? <span className="pane-dot" title={active ? "Active pane" : "Visible in layout"} /> : null}</span>
    </>
  );
}

/// The dev server offer for an Agent that sits in a Task worktree, already
/// resolved to that worktree. The menu names the worktree out loud, because
/// the same configuration means a different server in every checkout.
export type SessionRunDevServer = {
  name: string;
  running: boolean;
  start(): void;
};

export type SessionAgentActions = {
  askTargets: readonly { agentId: "claude" | "codex"; label: string }[];
  handoverTargets: readonly Session[];
  askTo(agentId: "claude" | "codex"): void;
  handoverTo(sessionId: string): void;
};

export function SessionContextMenu({ state, session, visible, canSplit, closeMenu, openHere, openInSplit, focus, closePane, rename, forkSession, repairProviderHistory, refreshAgent, agentActions, runDevServer, relocateSession, relocateToProject, copySessionId, dismissSession }: {
  state: SessionMenuState;
  session: Session;
  visible: boolean;
  canSplit: boolean;
  closeMenu(): void;
  openHere(): void;
  openInSplit(direction: SplitDirection): void;
  focus(): void;
  closePane(): void;
  rename(): void;
  forkSession(): void;
  repairProviderHistory?: (() => void) | undefined;
  refreshAgent?: (() => void) | undefined;
  agentActions?: SessionAgentActions | undefined;
  runDevServer?: SessionRunDevServer | undefined;
  relocateSession?: (() => void) | undefined;
  relocateToProject?: (() => void) | undefined;
  copySessionId(): void;
  dismissSession(): void;
}) {
  const menuRef = useRef<HTMLElement>(null);
  const agentsContainerRef = useRef<HTMLDivElement>(null);
  const agentsTriggerRef = useRef<HTMLButtonElement>(null);
  const agentsMenuRef = useRef<HTMLElement>(null);
  const agentsCloseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [position, setPosition] = useState({ left: state.x, top: state.y });
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(8, Math.min(state.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(state.y, window.innerHeight - rect.height - 8)),
    });
  }, [state.x, state.y, visible]);
  useEffect(() => { requestAnimationFrame(() => menuItems(menuRef.current)[0]?.focus()); }, []);
  useEffect(() => () => {
    if (agentsCloseTimerRef.current) clearTimeout(agentsCloseTimerRef.current);
  }, []);
  const run = (action: () => void) => { action(); closeMenu(); };
  const cancelAgentsClose = () => {
    if (!agentsCloseTimerRef.current) return;
    clearTimeout(agentsCloseTimerRef.current);
    agentsCloseTimerRef.current = undefined;
  };
  const openAgents = (focusFirst = false) => {
    cancelAgentsClose();
    setAgentsOpen(true);
    if (focusFirst) requestAnimationFrame(() => menuItems(agentsMenuRef.current)[0]?.focus());
  };
  const closeAgentsSoon = () => {
    cancelAgentsClose();
    agentsCloseTimerRef.current = setTimeout(() => {
      agentsCloseTimerRef.current = undefined;
      if (agentsContainerRef.current?.contains(document.activeElement)) return;
      setAgentsOpen(false);
    }, 120);
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const items = menuItems(menuRef.current);
    if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
    if (event.key === "ArrowRight" && event.currentTarget.ownerDocument.activeElement === agentsTriggerRef.current) {
      event.preventDefault();
      openAgents(true);
      return;
    }
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement));
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (event.key === "Tab") next = (current + (event.shiftKey ? -1 : 1) + items.length) % items.length;
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  };
  return (
    <div className="context-menu-layer">
      <button className="context-menu-backdrop" type="button" aria-label="Close Session menu" onClick={closeMenu} />
      <section ref={menuRef} className="context-menu" role="menu" aria-label={`${sessionLabel(session)} actions`} style={position} onKeyDown={keyDown}>
        <header><strong>{sessionLabel(session)}</strong><span>{visible ? "Visible in layout" : "Running in background"}</span></header>
        {visible ? (
          <>
            <MenuButton icon="focus" label="Focus pane" shortcut="↵" action={() => run(focus)} />
            <MenuButton icon="close" label="Close pane" detail="Session keeps running" action={() => run(closePane)} />
          </>
        ) : (
          <>
            <MenuButton icon="focus" label="Open here" detail="Replace active pane" action={() => run(openHere)} />
            <div className="context-menu-divider" />
            <MenuButton icon="panelRight" label="Open in split right" disabled={!canSplit} action={() => run(() => openInSplit("horizontal"))} />
            <MenuButton icon="panelDown" label="Open in split down" disabled={!canSplit} action={() => run(() => openInSplit("vertical"))} />
          </>
        )}
        <div className="context-menu-divider" />
        {runDevServer ? <MenuButton
          icon="play"
          label={runDevServer.running ? "Open dev server" : "Run dev server"}
          detail={runDevServer.running
            ? `${runDevServer.name} is already running in this Task's worktree`
            : `Start ${runDevServer.name} in this Task's worktree`}
          action={() => run(runDevServer.start)}
        /> : null}
        {refreshAgent ? <MenuButton
          icon="restart"
          label="Refresh agent display"
          detail="Restart the provider TUI and continue the same conversation"
          action={() => run(refreshAgent)}
        /> : null}
        {session.kind === "Agent" ? <MenuButton icon="fork" label="Fork conversation" action={() => run(forkSession)} /> : null}
        {repairProviderHistory ? <MenuButton icon="restart" label="Repair provider history…" detail="Back up and repair known restart damage" action={() => run(repairProviderHistory)} /> : null}
        {agentActions ? <div
          ref={agentsContainerRef}
          className="context-menu-submenu"
          onPointerOver={() => openAgents()}
          onPointerOut={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            closeAgentsSoon();
          }}
          onFocusCapture={cancelAgentsClose}
          onBlurCapture={(event) => {
            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
            cancelAgentsClose();
            setAgentsOpen(false);
          }}
        >
          <MenuButton
            buttonRef={agentsTriggerRef}
            icon="agent"
            label="Agents"
            shortcut="›"
            hasPopup
            expanded={agentsOpen}
            action={() => agentsOpen ? setAgentsOpen(false) : openAgents(true)}
          />
          <section
            ref={agentsMenuRef}
            className={`context-submenu-menu ${state.x > (typeof window === "undefined" ? 640 : window.innerWidth / 2) ? "left" : "right"} ${state.y > (typeof window === "undefined" ? 400 : window.innerHeight / 2) ? "up" : "down"}${agentsOpen ? " open" : ""}`}
            role="menu"
            aria-label="Agent coordination"
            aria-hidden={!agentsOpen}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft") return;
              event.preventDefault();
              event.stopPropagation();
              setAgentsOpen(false);
              agentsTriggerRef.current?.focus();
            }}
          >
            <div className="context-submenu-heading">Ask to</div>
            {agentActions.askTargets.length ? agentActions.askTargets.map((target) => <MenuButton
              key={target.agentId}
              icon={target.agentId}
              label={target.label}
              detail="Start a tracked helper request"
              tabIndex={agentsOpen ? 0 : -1}
              action={() => run(() => agentActions.askTo(target.agentId))}
            />) : <MenuButton icon="agent" label="No providers available" disabled tabIndex={-1} action={() => {}} />}
            <div className="context-menu-divider" />
            <div className="context-submenu-heading">Handover to</div>
            {agentActions.handoverTargets.length ? agentActions.handoverTargets.map((target) => <MenuButton
              key={target.id}
              icon={target.process.agent_id === "claude" ? "claude" : "codex"}
              label={sessionLabel(target)}
              detail={`${target.process.agent_id === "claude" ? "Claude" : "Codex"} · ${target.id.slice(0, 8)}`}
              tabIndex={agentsOpen ? 0 : -1}
              action={() => run(() => agentActions.handoverTo(target.id))}
            />) : <MenuButton icon="agent" label="No other running agents" disabled tabIndex={-1} action={() => {}} />}
          </section>
        </div> : null}
        {relocateSession ? <MenuButton icon="task" label="Continue in Task worktree…" detail="Replace this process inside the Task worktree" action={() => run(relocateSession)} /> : null}
        {relocateToProject ? <MenuButton icon="agent" label="Move to Project checkout…" detail="Resume this conversation in the Project checkout" action={() => run(relocateToProject)} /> : null}
        <MenuButton icon="edit" label="Rename…" action={() => run(rename)} />
        {session.kind === "Agent" ? <MenuButton icon="copy" label="Copy Session ID" action={() => run(copySessionId)} /> : null}
        {dismissalMenuItem(session, () => run(dismissSession))}
      </section>
    </div>
  );
}

export function MenuButton({ icon, label, detail, shortcut, disabled, danger, tabIndex, hasPopup, expanded, buttonRef, action }: {
  icon: IconName;
  label: string;
  detail?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  tabIndex?: number;
  hasPopup?: boolean;
  expanded?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  action(): void;
}) {
  return <button ref={buttonRef} className={danger ? "danger" : undefined} type="button" role="menuitem" disabled={disabled} tabIndex={tabIndex} aria-haspopup={hasPopup ? "menu" : undefined} aria-expanded={hasPopup ? expanded : undefined} onClick={action}><Icon name={icon} /><span><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</span>{shortcut ? <kbd>{shortcut}</kbd> : null}</button>;
}

function dismissalMenuItem(session: Session, action: () => void) {
  const dismissal = sessionDismissal(session);
  if (!dismissal) {
    return <MenuButton icon="stop" label="Close Session" detail="Blocked while runtime ownership is uncertain" disabled danger action={action} />;
  }
  return dismissal.verb === "Remove"
    ? <MenuButton icon="stop" label="Remove Session" detail="It already stopped" danger action={action} />
    : <MenuButton icon="stop" label="Close Session" detail="End its process and remove it" danger action={action} />;
}

function menuItems(root: HTMLElement | null): HTMLButtonElement[] {
  return root ? [...root.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled):not([tabindex="-1"])')] : [];
}
