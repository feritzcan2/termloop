import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { rightSidebarLabel } from "./RightActivityBar.js";
import type { RightSidebarView } from "./types.js";

/**
 * The right panel left of the activity bar: a header with the view's name and
 * a close button, the view's body, and a resize handle on its left edge.
 * `onResize` gets the requested width; the caller clamps it.
 */
export function RightSidebar(props: { view: RightSidebarView; width: number; onResize(width: number): void; onClose(): void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const label = rightSidebarLabel(props.view);
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panel.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const right = panel.current.getBoundingClientRect().right;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (pointer: globalThis.PointerEvent) => props.onResize(right - pointer.clientX);
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
    const next = event.key === "ArrowLeft" ? props.width + step : event.key === "ArrowRight" ? props.width - step : undefined;
    if (next === undefined) return;
    event.preventDefault();
    props.onResize(next);
  };
  return (
    <aside ref={panel} className="right-sidebar" aria-label={label}>
      <div
        className={`right-sidebar-resize ${dragging ? "dragging" : ""}`}
        role="separator"
        aria-label={`Resize ${label} sidebar`}
        aria-orientation="vertical"
        aria-valuenow={props.width}
        tabIndex={0}
        title="Drag to resize"
        onPointerDown={startDrag}
        onKeyDown={keyResize}
      />
      <header className="right-sidebar-header">
        <h2>{label}</h2>
        <button type="button" className="icb" aria-label={`Close ${label} sidebar`} title={`Close ${label} sidebar`} onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="right-sidebar-body">{props.children}</div>
    </aside>
  );
}
