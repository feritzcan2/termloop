// Ticket drag-and-drop shared by both sidebars: the left sidebar's tickets are
// sortable items, the right Sprints panel's rows are drop targets. One
// DndContext wraps the shell so a drag can cross from one to the other.
import { DndContext, PointerSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import type { ReactNode } from "react";
import type { PmBoardTicket } from "@termloop/pm-contract/pm";

const LANE_PREFIX = "lane:";
const NO_SPRINT = `${LANE_PREFIX}none`;

/** Drop target id of a sprint row; `null` is the "No sprint" bucket. */
export function laneId(sprintId: string | null): string {
  return sprintId === null ? NO_SPRINT : `${LANE_PREFIX}${sprintId}`;
}

/**
 * Where a drag ends: onto a sprint row (move to its end), or onto another
 * ticket of the shown lane (reorder to that position). Facts place a ticket
 * on a Playbook step, so a drop never changes its status. `undefined` is a no-op.
 */
export function dropTarget(
  activeId: string,
  overId: string | undefined,
  lane: PmBoardTicket[],
  laneSprintId: string,
): { sprintId: string | null; index?: number } | undefined {
  if (!overId || overId === activeId) return undefined;
  if (overId.startsWith(LANE_PREFIX)) {
    const sprintId = overId === NO_SPRINT ? null : overId.slice(LANE_PREFIX.length);
    return sprintId === laneSprintId ? undefined : { sprintId };
  }
  const index = lane.findIndex((entry) => entry.ticket.id === overId);
  if (index < 0 || !lane.some((entry) => entry.ticket.id === activeId)) return undefined;
  return { sprintId: laneSprintId, index };
}

/** The drag context for the lane the left sidebar shows. */
export function SprintDnd(props: {
  lane: PmBoardTicket[];
  laneSprintId: string | undefined;
  onMoveTicket(ticketId: string, sprintId: string | null, index?: number): void;
  children: ReactNode;
}) {
  // Pointer only: a short move starts a drag, so a click still selects. The
  // keyboard path is each row's move menu.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const dragEnd = (event: DragEndEvent) => {
    if (props.laneSprintId === undefined) return;
    const ticketId = String(event.active.id);
    const target = dropTarget(ticketId, event.over ? String(event.over.id) : undefined, props.lane, props.laneSprintId);
    if (!target) return;
    props.onMoveTicket(ticketId, target.sprintId, target.index);
  };
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>{props.children}</DndContext>;
}

/** A sprint row (or the "No sprint" bucket) as a drop target. */
export function useLaneDrop(sprintId: string | null, disabled = false) {
  return useDroppable({ id: laneId(sprintId), disabled });
}
