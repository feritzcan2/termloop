import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Fragment, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { RunConfiguration, RunRuntime, Session } from "../model.js";
import { basename, sessionLabel } from "../model.js";
import { Icon } from "./Icon.js";
import { RunSessionLine, runCommandsBySessionId, runtimesBySessionId } from "./TaskRuns.js";
import { RailHeader } from "./RailHeader.js";
import { SessionRowButton, SessionRowClose } from "./SessionRow.js";
import {
  SidebarSessionDndProvider,
  useOptionalSidebarSessionDnd,
  useSidebarSessionDnd,
  type SessionDropPlacement,
} from "./SidebarSessionDnd.js";

/// The Project's own Sessions that are not Agents: terminals opened here and
/// the dev-server runs started in the Project checkout.
///
/// It sits under the Agents rail, in the view that holds every live Session the
/// user launches for the Project itself — so a terminal opened from that view's
/// launch bar is listed in the same view. The Tasks view keeps Tasks alone.
/// `sessions` stays the Project's loose Session projection and this rail renders
/// the terminals among them; Agents belong to the rail above it.
export type SessionRailProps = {
  sessions: readonly Session[];
  selectedSession: Session | undefined;
  visibleSessionIds: ReadonlySet<string>;
  menuSessionId: string | undefined;
  selectSession(sessionId: string): void;
  navigateSession(sessionId: string): void;
  openSessionMenu(sessionId: string, x: number, y: number, invoker: HTMLElement): void;
  dismissSession(sessionId: string): void;
  resumeSession(sessionId: string): void;
  reorderSession(sessionId: string, targetSessionId: string, placement: "before" | "after"): boolean;
  /// Present for the Project list, where a run started in the Project's own
  /// checkout appears. Task groups pass their own.
  runRuntimes?: readonly RunRuntime[] | undefined;
  runConfigurations?: readonly RunConfiguration[] | undefined;
  restartRun?: ((configurationId: string) => Promise<string | undefined>) | undefined;
  openExternal?: ((url: string, runSessionId?: string) => Promise<void>) | undefined;
};

export function SessionRail(props: SessionRailProps) {
  const sharedDnd = useOptionalSidebarSessionDnd();
  if (sharedDnd) return <SessionRailContent {...props} />;
  return (
    <SidebarSessionDndProvider sessions={props.sessions} reorderSession={props.reorderSession}>
      <SessionRailContent {...props} />
    </SidebarSessionDndProvider>
  );
}

function SessionRailContent(props: SessionRailProps) {
  const { sessionDropTarget: dropTarget } = useSidebarSessionDnd();
  const runtimeBySession = useMemo(
    () => runtimesBySessionId(props.runRuntimes ?? []),
    [props.runRuntimes],
  );
  const runCommandBySession = useMemo(
    () => runCommandsBySessionId(props.runRuntimes ?? [], props.runConfigurations ?? []),
    [props.runRuntimes, props.runConfigurations],
  );
  const terminals = useMemo(
    () => props.sessions.filter((session) => session.kind === "Terminal"),
    [props.sessions],
  );
  const navigateSessions = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!(event.key === "ArrowDown" || event.key === "ArrowUp") || terminals.length === 0) return;
    event.preventDefault();
    const selectedIndex = terminals.findIndex((session) => session.id === props.selectedSession?.id);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = selectedIndex < 0
      ? (direction > 0 ? 0 : terminals.length - 1)
      : (selectedIndex + direction + terminals.length) % terminals.length;
    const next = terminals[nextIndex];
    if (!next) return;
    props.navigateSession(next.id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-session-id="${next.id}"]`)?.focus());
  };
  /// A Project with no terminal has nothing to say here. An empty header would
  /// only take rail height from the Task list directly above it.
  if (terminals.length === 0) return null;

  return (
    <nav className="session-navigation" aria-label="Live sessions" onKeyDown={navigateSessions}>
      <TerminalGroup
        sessions={terminals}
        selectedId={props.selectedSession?.id}
        visibleIds={props.visibleSessionIds}
        menuSessionId={props.menuSessionId}
        dropTarget={dropTarget}
        select={props.selectSession}
        openMenu={props.openSessionMenu}
        dismiss={props.dismissSession}
        resume={props.resumeSession}
        runtimeBySession={runtimeBySession}
        runCommandBySession={runCommandBySession}
        restartRun={props.restartRun}
        openExternal={props.openExternal}
      />
    </nav>
  );
}

function TerminalGroup({ sessions, selectedId, visibleIds, menuSessionId, dropTarget, select, openMenu, dismiss, resume, runtimeBySession, runCommandBySession, restartRun, openExternal }: {
  sessions: readonly Session[];
  selectedId: string | undefined;
  visibleIds: ReadonlySet<string>;
  menuSessionId: string | undefined;
  dropTarget: { sessionId: string; placement: SessionDropPlacement } | undefined;
  select(sessionId: string): void;
  openMenu(sessionId: string, x: number, y: number, invoker: HTMLElement): void;
  dismiss(sessionId: string): void;
  resume(sessionId: string): void;
  runtimeBySession: ReadonlyMap<string, RunRuntime>;
  runCommandBySession: ReadonlyMap<string, string>;
  restartRun?: ((configurationId: string) => Promise<string | undefined>) | undefined;
  openExternal?: ((url: string, runSessionId?: string) => Promise<void>) | undefined;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="rail-section session-group" aria-label="Terminal sessions">
      <RailHeader collapsed={collapsed} label="Terminals" toggle={() => setCollapsed((value) => !value)}>
        <span className="rail-glyph" aria-hidden="true"><Icon name="terminal" /></span>
        <div className="rail-heading"><h2>Terminals</h2></div>
        <span className="count-badge">{sessions.length}</span>
        <span />
      </RailHeader>
      {collapsed ? null : (
        <SortableContext items={sessions.map((session) => session.id)} strategy={verticalListSortingStrategy}>
          <div className="session-list" role="list" aria-label="Terminal sessions">
            {sessions.map((session) => (
              <Fragment key={session.id}>
                <SortableSessionItem
                  session={session}
                  active={session.id === selectedId}
                  visible={visibleIds.has(session.id)}
                  menuOpen={session.id === menuSessionId}
                  dropPlacement={dropTarget?.sessionId === session.id ? dropTarget.placement : undefined}
                  runCommand={runCommandBySession.get(session.id)}
                  onSelect={() => select(session.id)}
                  onContextMenu={(x, y, invoker) => openMenu(session.id, x, y, invoker)}
                  onDismiss={() => dismiss(session.id)}
                  onResume={() => resume(session.id)}
                />
                {runtimeBySession.get(session.id) && restartRun && openExternal ? <RunSessionLine
                  session={session}
                  runtime={runtimeBySession.get(session.id)!}
                  restart={() => restartRun(runtimeBySession.get(session.id)!.configurationId)}
                  stop={() => dismiss(session.id)}
                  openExternal={openExternal}
                /> : null}
              </Fragment>
            ))}
          </div>
        </SortableContext>
      )}
    </section>
  );
}

function SortableSessionItem({ session, active, visible, menuOpen, dropPlacement, runCommand, onSelect, onContextMenu, onDismiss, onResume }: {
  session: Session;
  active: boolean;
  visible: boolean;
  menuOpen: boolean;
  dropPlacement: SessionDropPlacement | undefined;
  runCommand?: string | undefined;
  onSelect(): void;
  onContextMenu(x: number, y: number, invoker: HTMLElement): void;
  onDismiss(): void;
  onResume(): void;
}) {
  const sortable = useSortable({ id: session.id, data: { kind: "session", sessionId: session.id } });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={`session-row${sortable.isDragging ? " dragging" : ""}${dropPlacement ? ` drop-${dropPlacement}` : ""}`}
      role="listitem"
    >
      <button
        className="session-drag-handle"
        type="button"
        aria-label={`Reorder ${sessionLabel(session)}`}
        {...sortable.attributes}
        {...sortable.listeners}
        onClick={(event) => event.stopPropagation()}
      ><Icon name="grip" /></button>
      <SessionRowButton
        session={session}
        agentStatus={undefined}
        subtitle={basename(session.process.cwd)}
        active={active}
        visible={visible}
        menuOpen={menuOpen}
        runCommand={runCommand}
        dragAttributes={sortable.attributes}
        dragListeners={sortable.listeners}
        select={onSelect}
        openMenu={onContextMenu}
      />
      <SessionRowClose session={session} dismiss={onDismiss} resume={onResume} />
    </div>
  );
}
