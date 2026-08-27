import { useEffect, useRef, useState } from "react";
import type { ErrorLogEntry } from "../state/projection-store.js";

export function ErrorLogPanel({ entries, clear }: {
  entries: readonly ErrorLogEntry[];
  clear(): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="error-log-control">
      <button
        type="button"
        className={`error-log-trigger${entries.length > 0 ? " has-errors" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="error-log-trigger-dot" aria-hidden="true" />
        <span>Errors</span>
        <strong>{entries.length}</strong>
      </button>
      {open ? <section className="error-log-panel" role="dialog" aria-label="Error log">
        <header>
          <div><span>Diagnostics</span><h2>Error log</h2></div>
          <button type="button" disabled={entries.length === 0} onClick={clear}>Clear</button>
        </header>
        {entries.length === 0
          ? <p className="error-log-empty">No errors in this app run.</p>
          : <ol>{[...entries].reverse().map((entry) => <li key={entry.id}>
            <time dateTime={new Date(entry.occurredAtEpochMs).toISOString()}>{formatLogTime(entry.occurredAtEpochMs)}</time>
            <p>{entry.message}</p>
          </li>)}</ol>}
      </section> : null}
    </div>
  );
}

function formatLogTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
