import type { ReactNode } from "react";
import { Icon } from "./icons.js";
import { ResizeHandle, type WidthBounds } from "./ResizeHandle.js";
import { rightSidebarLabel } from "./RightActivityBar.js";
import type { RightSidebarView } from "./types.js";

/**
 * The right panel left of the activity bar: a header with the view's name and
 * a close button, the view's body, and a resize handle on its left edge.
 * `onResize` gets the requested width; the caller clamps it.
 */
export function RightSidebar(props: { view: RightSidebarView; width: number; bounds: WidthBounds; onResize(width: number): void; onClose(): void; children: ReactNode }) {
  const label = rightSidebarLabel(props.view);
  return (
    <aside className="right-sidebar" aria-label={label}>
      <ResizeHandle edge="left" label={`${label} sidebar`} width={props.width} bounds={props.bounds} onResize={props.onResize} />
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
