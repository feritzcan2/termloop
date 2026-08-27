import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SplitDirection, SplitPlacement } from "../../layout/model.js";
import type { Session } from "../model.js";
import { sessionLabel } from "../model.js";
import { Icon } from "./Icon.js";

export type SessionDropPlacement = "before" | "after" | "on";
export type SessionDropTarget = {
  kind: "session";
  sessionId: string;
  placement: SessionDropPlacement;
  surface?: "row" | "group";
};
export type TaskDropTarget = { kind: "task"; taskId: string };
export type ProjectDropTarget = { kind: "project" };
export type SplitDropTarget = { kind: "split"; paneId: string; direction: SplitDirection; placement: SplitPlacement };
type SidebarDropTarget = SessionDropTarget | TaskDropTarget | ProjectDropTarget | SplitDropTarget;

const sidebarPointerWithin: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  const sessionIndex = collisions.findIndex((collision) =>
    ["session", "agentGroup"].includes(
      args.droppableContainers.find((container) => container.id === collision.id)?.data.current?.kind,
    )
  );
  if (sessionIndex > 0) {
    return [collisions[sessionIndex]!, ...collisions.filter((_, index) => index !== sessionIndex)];
  }
  if (sessionIndex === 0) return collisions;
  const projectIndex = collisions.findIndex((collision) => collision.id === "project:checkout");
  if (projectIndex <= 0) return collisions;
  return [collisions[projectIndex]!, ...collisions.filter((_, index) => index !== projectIndex)];
};

type SidebarSessionDndState = {
  draggedSession: Session | undefined;
  sessionDropTarget: SessionDropTarget | undefined;
  taskDropTargetId: string | undefined;
  projectDropTarget: boolean;
  splitDropTarget: SplitDropTarget | undefined;
  dropNotice: string | undefined;
};

const SidebarSessionDndContext = createContext<SidebarSessionDndState | undefined>(undefined);

export function useOptionalSidebarSessionDnd(): SidebarSessionDndState | undefined {
  return useContext(SidebarSessionDndContext);
}

export function useSidebarSessionDnd(): SidebarSessionDndState {
  const value = useOptionalSidebarSessionDnd();
  if (!value) throw new Error("Sidebar Session drag state is unavailable");
  return value;
}

export function isTaskRelocationDragCandidate(session: Session): boolean {
  return session.kind === "Agent"
    && (session.lifecycle_state === "running"
      || (session.lifecycle_state === "resumeFailed" && session.retryable))
    && session.ask_to_source_session_id === null
    && matchesOrdinaryAgentTemplate(session.process.template_ref)
    && matchesRelocatableAgent(session.process.agent_id);
}

export function isProjectRelocationDragCandidate(session: Session): boolean {
  return session.kind === "Agent"
    && (session.lifecycle_state === "running"
      || (session.lifecycle_state === "resumeFailed" && session.retryable))
    && matchesRelocatableAgent(session.process.agent_id);
}

function matchesOrdinaryAgentTemplate(template: string | null): boolean {
  return template === "builtin.agent.interactive" || template === "builtin.quick-action.free-prompt";
}

function matchesRelocatableAgent(agentId: string | null): boolean {
  return agentId === "claude" || agentId === "codex";
}

export function SidebarSessionDndProvider({ sessions, reorderSession, groupAgentSessions, requestTaskRelocation, requestProjectRelocation, requestSplit, draggingChanged, children }: {
  sessions: readonly Session[];
  reorderSession(sessionId: string, targetSessionId: string, placement: "before" | "after"): boolean;
  groupAgentSessions?: ((sessionId: string, targetSessionId: string) => boolean) | undefined;
  requestTaskRelocation?: ((sessionId: string, taskId: string) => boolean) | undefined;
  requestProjectRelocation?: ((sessionId: string) => boolean) | undefined;
  requestSplit?: ((sessionId: string, paneId: string, direction: SplitDirection, placement: SplitPlacement) => boolean) | undefined;
  draggingChanged?: ((dragging: boolean) => void) | undefined;
  children: ReactNode;
}) {
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<SidebarDropTarget>();
  const [dropNotice, setDropNotice] = useState<string>();
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyboardDrag = useRef(false);
  const lastDropTarget = useRef<SidebarDropTarget | undefined>(undefined);
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const draggedSession = draggedId ? sessionsById.get(draggedId) : undefined;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    draggingChanged?.(false);
  }, [draggingChanged]);

  const showNotice = (message: string) => {
    setDropNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setDropNotice(undefined), 2_400);
  };
  const resetDrag = () => {
    setDraggedId(undefined);
    setDropTarget(undefined);
    keyboardDrag.current = false;
    lastDropTarget.current = undefined;
    draggingChanged?.(false);
  };
  const updateDropTarget = (event: DragMoveEvent | DragOverEvent | DragEndEvent) => {
    const target = resolveDropTarget(event, keyboardDrag.current, sessions);
    if (target) {
      lastDropTarget.current = target;
      setDropTarget(target);
    } else if (!keyboardDrag.current) {
      setDropTarget(undefined);
    }
    return target;
  };
  const dragStart = (event: DragStartEvent) => {
    const sessionId = event.active.data.current?.sessionId;
    setDraggedId(typeof sessionId === "string" ? sessionId : String(event.active.id));
    keyboardDrag.current = event.activatorEvent instanceof KeyboardEvent;
    draggingChanged?.(true);
  };
  const dragEnd = (event: DragEndEvent) => {
    const sourceId = typeof event.active.data.current?.sessionId === "string"
      ? event.active.data.current.sessionId
      : String(event.active.id);
    const target = updateDropTarget(event) ?? (keyboardDrag.current ? lastDropTarget.current : undefined);
    const source = sessionsById.get(sourceId);
    if (source && target?.kind === "project") {
      if (!isProjectRelocationDragCandidate(source)) {
        showNotice("Only a live or retryable Claude or Codex Agent can leave a Task worktree.");
      } else if (!requestProjectRelocation?.(source.id)) {
        showNotice("That Agent cannot be moved to the Project checkout.");
      }
    } else if (source && target?.kind === "task") {
      if (!isTaskRelocationDragCandidate(source)) {
        showNotice("Only a live or retryable ordinary Claude or Codex Agent can move to a Task worktree.");
      } else if (!requestTaskRelocation?.(source.id, target.taskId)) {
        showNotice("That Agent cannot be moved to this Task.");
      }
    } else if (source && target?.kind === "split") {
      if (!requestSplit?.(source.id, target.paneId, target.direction, target.placement)) {
        showNotice("That Session could not be opened in a split pane.");
      }
    } else if (source && target?.kind === "session") {
      const targetSession = sessionsById.get(target.sessionId);
      if (targetSession && source.id !== targetSession.id) {
        if (target.placement === "on") {
          if (source.kind !== "Agent" || targetSession.kind !== "Agent") {
            showNotice("Only Agents can be grouped.");
          } else if (isNestedAgent(source) || isNestedAgent(targetSession)) {
            showNotice("Ask-To and fork helpers stay with their source Agent.");
          } else if (!groupAgentSessions?.(source.id, targetSession.id)) {
            showNotice(`${sessionLabel(source)} and ${sessionLabel(targetSession)} could not be grouped.`);
          }
        } else if (source.kind !== targetSession.kind) {
          showNotice("Reorder stays inside its Session section.");
        } else if (!reorderSession(source.id, targetSession.id, target.placement)) {
          showNotice("That Session could not be reordered.");
        }
      }
    }
    resetDrag();
  };
  const context = useMemo<SidebarSessionDndState>(() => ({
    draggedSession,
    sessionDropTarget: dropTarget?.kind === "session" ? dropTarget : undefined,
    taskDropTargetId: dropTarget?.kind === "task" ? dropTarget.taskId : undefined,
    projectDropTarget: dropTarget?.kind === "project",
    splitDropTarget: dropTarget?.kind === "split" ? dropTarget : undefined,
    dropNotice,
  }), [draggedSession, dropNotice, dropTarget]);

  return (
    <SidebarSessionDndContext.Provider value={context}>
      <DndContext
        sensors={sensors}
        collisionDetection={keyboardDrag.current ? closestCenter : sidebarPointerWithin}
        onDragStart={dragStart}
        onDragMove={updateDropTarget}
        onDragOver={updateDropTarget}
        onDragCancel={resetDrag}
        onDragEnd={dragEnd}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {draggedSession ? <SessionDragPreview session={draggedSession} /> : null}
        </DragOverlay>
        {dropNotice ? <div className="drop-notice" role="status">{dropNotice}</div> : null}
      </DndContext>
    </SidebarSessionDndContext.Provider>
  );
}

function isNestedAgent(session: Session): boolean {
  return Boolean(session.ask_to_source_session_id || session.fork_source_session_id);
}

function SessionDragPreview({ session }: { session: Session }) {
  return <div className="session-drag-preview"><Icon name={session.kind === "Agent" ? "agent" : "terminal"} /><strong>{sessionLabel(session)}</strong></div>;
}

function resolveDropTarget(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  keyboard: boolean,
  sessions: readonly Session[],
): SidebarDropTarget | undefined {
  if (!event.over || event.active.id === event.over.id) return undefined;
  if (event.over.data.current?.kind === "project") return { kind: "project" };
  if (event.over.data.current?.kind === "task") {
    const taskId = event.over.data.current.taskId;
    return typeof taskId === "string" ? { kind: "task", taskId } : undefined;
  }
  if (event.over.data.current?.kind === "split") {
    const paneId = event.over.data.current.paneId;
    if (typeof paneId !== "string") return undefined;
    const split = splitDropPlacement(event);
    return { kind: "split", paneId, ...split };
  }
  if (event.over.data.current?.kind === "agentGroup") {
    const sessionId = event.over.data.current.sessionId;
    return typeof sessionId === "string"
      ? { kind: "session", sessionId, placement: "on", surface: "group" }
      : undefined;
  }
  const sessionId = typeof event.over.data.current?.sessionId === "string"
    ? event.over.data.current.sessionId
    : String(event.over.id);
  if (keyboard) {
    const sourceId = typeof event.active.data.current?.sessionId === "string"
      ? event.active.data.current.sessionId
      : String(event.active.id);
    const sourceIndex = sessions.findIndex((session) => session.id === sourceId);
    const targetIndex = sessions.findIndex((session) => session.id === sessionId);
    if (sourceIndex < 0 || targetIndex < 0) return undefined;
    return { kind: "session", sessionId, placement: sourceIndex < targetIndex ? "after" : "before" };
  }
  const translated = event.active.rect.current.translated;
  if (!translated) return undefined;
  const center = translated.top + translated.height / 2;
  const relative = (center - event.over.rect.top) / event.over.rect.height;
  return {
    kind: "session",
    sessionId,
    placement: relative < 0.28 ? "before" : relative > 0.72 ? "after" : "on",
  };
}

export type SplitDropPosition = {
  direction: SplitDirection;
  placement: SplitPlacement;
};

export function splitDropPositionFromPoint(relativeX: number, relativeY: number): SplitDropPosition {
  const distances = [
    { distance: relativeX, direction: "horizontal" as const, placement: "before" as const },
    { distance: 1 - relativeX, direction: "horizontal" as const, placement: "after" as const },
    { distance: relativeY, direction: "vertical" as const, placement: "before" as const },
    { distance: 1 - relativeY, direction: "vertical" as const, placement: "after" as const },
  ];
  const closest = distances.reduce((best, candidate) => candidate.distance < best.distance ? candidate : best);
  return { direction: closest.direction, placement: closest.placement };
}

function splitDropPlacement(event: DragMoveEvent | DragOverEvent | DragEndEvent): SplitDropPosition {
  const translated = event.active.rect.current.translated;
  const over = event.over;
  if (!translated || !over || over.rect.width <= 0 || over.rect.height <= 0) {
    return { direction: "horizontal", placement: "after" };
  }
  const centerX = translated.left + translated.width / 2;
  const centerY = translated.top + translated.height / 2;
  return splitDropPositionFromPoint(
    (centerX - over.rect.left) / over.rect.width,
    (centerY - over.rect.top) / over.rect.height,
  );
}
