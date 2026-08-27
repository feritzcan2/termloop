import type { ReactNode } from "react";

import { Icon } from "./Icon.js";

/// One labelled group of rail rows. A group with `toggle` collapses; one
/// without stays open and shows its icon instead of a caret. Skills, MCP tools,
/// and Prompts all group their rails this way.
export function RailGroup({ className = "rail-group", label, count, title, icon, collapsed = false, toggle, children }: {
  className?: string;
  label: string;
  count: number;
  title?: string | undefined;
  icon?: ReactNode;
  collapsed?: boolean;
  toggle?: (() => void) | undefined;
  children: ReactNode;
}) {
  return <div className={className}>
    {toggle
      ? <button className={`${className}-head`} type="button" aria-expanded={!collapsed} title={title} onClick={toggle}>
        <i aria-hidden="true" /><span>{label}</span><strong>{count}</strong>
      </button>
      : <header className={`${className}-head`} title={title}>
        {icon}<span>{label}</span><strong>{count}</strong>
      </header>}
    {collapsed ? null : children}
  </div>;
}

/// One rail row: the entry itself, plus the Improve-with-agent action that
/// appears when the row is hovered or focused. The action is a sibling button
/// rather than something inside the row's own button.
export function RailRow({ label, detail, mark, selected = false, open, improve }: {
  label: string;
  detail?: ReactNode | undefined;
  /// Shown next to the label when the entry no longer matches its canonical
  /// value.
  mark?: string | undefined;
  selected?: boolean;
  open(): void;
  improve?: (() => void) | undefined;
}) {
  return <div className={`rail-row${selected ? " selected" : ""}`}>
    <button className="rail-row-open" type="button" aria-current={selected} onClick={open}>
      <strong>{label}{mark ? <i className="rail-row-mark" aria-label={mark} /> : null}</strong>
      {detail ? <small>{detail}</small> : null}
    </button>
    {improve ? <button
      className="rail-row-improve"
      type="button"
      title="Improve with agent"
      aria-label={`Improve ${label} with agent`}
      onClick={improve}
    ><Icon name="sparkles" /></button> : null}
  </div>;
}
