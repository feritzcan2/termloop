export type SidebarFooterHoverTone = "positive" | "negative";

export type SidebarFooterHoverRow = {
  label: string;
  value: string;
  tone?: SidebarFooterHoverTone | undefined;
};

/**
 * The footer tiles show only a glyph, so hovering or focusing one reveals a
 * small card with what the tile controls and its current state. It is purely
 * presentational: CSS shows it on hover/focus and hides it while the tile's
 * own popover is open.
 */
export function SidebarFooterHoverCard({ id, eyebrow, title, status, statusTone, rows = [], note, hint }: {
  id: string;
  eyebrow: string;
  title: string;
  status?: string | undefined;
  statusTone?: SidebarFooterHoverTone | undefined;
  rows?: readonly SidebarFooterHoverRow[];
  note?: string | undefined;
  hint: string;
}) {
  return (
    <div className="sidebar-footer-hover-card" role="tooltip" id={id}>
      <header>
        <span>{eyebrow}</span>
        <strong>{title}</strong>
      </header>
      {status ? <p className="sidebar-footer-hover-status" data-tone={statusTone}>{status}</p> : null}
      {rows.length > 0 ? <dl>{rows.map((row) => <div key={row.label}>
        <dt>{row.label}</dt>
        <dd data-tone={row.tone}>{row.value}</dd>
      </div>)}</dl> : null}
      {note ? <p className="sidebar-footer-hover-note">{note}</p> : null}
      <footer>{hint}</footer>
    </div>
  );
}
