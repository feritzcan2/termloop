import { useSyncExternalStore } from "react";
import type { TerminalPresentationPort } from "../terminal-presentation.js";
import "./terminal-status.css";

const subscribeEmpty = () => () => {};
export function TerminalStatus({ sessionId, port }: { sessionId: string; port?: TerminalPresentationPort | undefined }) {
  const state = useSyncExternalStore(port?.subscribe ?? subscribeEmpty, () => port?.snapshot(sessionId), () => port?.snapshot(sessionId));
  if (!state) return null;
  const reading = state.reading !== undefined;
  const phase = ({ connecting: "Connecting", replaying: "Loading recent output", live: "Live", reconnecting: "Reconnecting · last output retained", exited: "Process exited", failed: "Terminal unavailable" })[state.phase];
  const label = reading ? `Reading paused · ${state.phase === "live" ? "session keeps running" : phase}` : phase;
  const input = state.input ? ({ sending: "Sending…", confirmed: "Input reached terminal", uncertain: "Delivery unconfirmed" })[state.input] : undefined;
  return <>
    {reading ? <pre className="terminal-reading-view" tabIndex={0} aria-label="Paused terminal output">{state.reading || "No output yet."}</pre> : null}
    <div className="terminal-stream-status">
      <span role="status">{label}{state.progress === undefined ? "" : ` · ${state.progress}%`}{input ? ` · ${input}` : ""}{state.notice ? ` · ${state.notice}` : ""}</span>
      <div className="terminal-stream-actions">
        <button type="button" onClick={() => port?.read(sessionId, !reading)} aria-pressed={reading}>{reading ? `${state.unread ? "New output · " : ""}Return to live` : "Pause to read"}</button>
        {state.phase === "failed" ? <button type="button" onClick={() => port?.recover(sessionId)}>Reopen view</button> : null}
      </div>
    </div>
  </>;
}
