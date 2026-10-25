import { useState, type KeyboardEvent, type PointerEvent } from "react";

export type WidthBounds = { min: number; max: number; defaultWidth: number };

/**
 * A vertical drag handle on one edge of its parent panel. `edge` is the side
 * of the panel it sits on: dragging or pressing the arrow pointing away from
 * the panel widens it. Double-click resets to the default width. `onResize` gets
 * the requested width; the caller clamps it.
 */
export function ResizeHandle(props: {
  edge: "left" | "right";
  label: string;
  width: number;
  bounds: WidthBounds;
  onResize(width: number): void;
}) {
  const [dragging, setDragging] = useState(false);
  const grow = props.edge === "right" ? 1 : -1;
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.parentElement;
    if (event.button !== 0 || !panel) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const rect = panel.getBoundingClientRect();
    // The panel's fixed edge: the one opposite the handle.
    const anchor = props.edge === "right" ? rect.left : rect.right;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (pointer: globalThis.PointerEvent) => props.onResize((pointer.clientX - anchor) * grow);
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      setDragging(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 10;
    const direction = event.key === "ArrowRight" ? grow : event.key === "ArrowLeft" ? -grow : 0;
    if (direction === 0) return;
    event.preventDefault();
    props.onResize(props.width + direction * step);
  };
  return (
    <div
      className={`resize-handle edge-${props.edge} ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-label={`Resize ${props.label}`}
      aria-orientation="vertical"
      aria-valuenow={props.width}
      aria-valuemin={props.bounds.min}
      aria-valuemax={props.bounds.max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={startDrag}
      onKeyDown={keyResize}
      onDoubleClick={() => props.onResize(props.bounds.defaultWidth)}
    />
  );
}
