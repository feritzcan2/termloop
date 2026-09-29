import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TerminalPresentationPort } from "../terminal-presentation.js";
import "./terminal-status.css";
import { ConversationHistory } from "./ConversationHistory.js";

const subscribeEmpty = () => () => {};
export function TerminalStatus({ sessionId, port }: { sessionId: string; port?: TerminalPresentationPort | undefined }) {
  const state = useSyncExternalStore(port?.subscribe ?? subscribeEmpty, () => port?.snapshot(sessionId), () => port?.snapshot(sessionId));
  const conversationPort = port?.conversation;
  const conversation = useSyncExternalStore(conversationPort?.subscribe ?? subscribeEmpty, () => conversationPort?.snapshot(sessionId), () => conversationPort?.snapshot(sessionId));
  const savedMessagesAvailable = conversationPort?.supported(sessionId) ?? false;
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  useEffect(() => { setError(undefined); }, [sessionId, state?.phase]);
  useEffect(() => () => { conversationPort?.close(sessionId); }, [conversationPort, sessionId]);
  if (!state) return null;
  const reading = state.reading !== undefined;
  const unavailable = state.phase === "reconnecting" || state.phase === "failed" || state.phase === "connecting";
  const needsAttention = unavailable || state.input === "uncertain" || Boolean(state.notice);
  if (!reading && !needsAttention && !reconnecting && !error && !savedMessagesAvailable) return null;
  const phase = ({ connecting: "Connecting — input unavailable", replaying: "Loading recent output", live: "Live", reconnecting: "Connection lost — you cannot type here", exited: "Process exited", failed: "Terminal unavailable — input unavailable" })[state.phase];
  const input = state.input ? ({ sending: "Sending…", confirmed: "Input reached terminal", uncertain: "Last input delivery unconfirmed. Check the terminal before sending again." })[state.input] : undefined;
  const reconnect = async () => {
    if (pending.current || !port?.reconnect) return;
    pending.current = true;
    setReconnecting(true);
    setError(undefined);
    try { await port.reconnect(sessionId); }
    catch (failure) { setError(`Could not reconnect: ${failure instanceof Error ? failure.message : String(failure)}`); }
    finally { pending.current = false; setReconnecting(false); }
  };
  return <>
    {conversation && conversationPort ? <ConversationHistory sessionId={sessionId} state={conversation} port={conversationPort} /> : reading ? <pre className="terminal-reading-view" tabIndex={0} aria-label="Paused terminal output">{state.reading || "No output yet."}</pre> : null}
    <div className={`terminal-stream-status${unavailable ? " terminal-stream-status--unavailable" : ""}`}>
      <div className="terminal-stream-message" role={unavailable ? "alert" : "status"}>
        <strong>{unavailable ? "⚠ " : ""}{phase}{state.progress === undefined ? "" : ` · ${state.progress}%`}</strong>
        {unavailable ? <span>{state.phase === "failed" ? "Reconnect to the computer or reopen the terminal view." : "Trying to reconnect automatically. The output shown may be out of date."}</span> : null}
        {reading ? <span>Reading paused · {state.phase === "live" ? "session keeps running" : "return to live after reconnecting"}</span> : null}
        {input ? <span>{input}</span> : null}
        {state.notice && !state.notice.startsWith("Input delivery unconfirmed.") ? <span>{state.notice}</span> : null}
        {error ? <span role="alert">{error}</span> : null}
      </div>
      <div className="terminal-stream-actions">
        {savedMessagesAvailable && !conversation ? <button type="button" onClick={() => conversationPort?.open(sessionId)} title="Read saved user and assistant messages, including messages no longer in terminal scrollback">Earlier messages</button> : null}
        {port?.reconnect && (unavailable || reconnecting || error) ? <button type="button" className="terminal-reconnect-button" disabled={reconnecting} onClick={() => { void reconnect(); }} title="Reset control and terminal connections for this computer. Running sessions are preserved.">{reconnecting ? "Reconnecting…" : "Force reconnect"}</button> : null}
        {state.phase === "failed" ? <button type="button" onClick={() => port?.recover(sessionId)}>Reopen view</button> : null}
        {!conversation ? <button type="button" onClick={() => port?.read(sessionId, !reading)} aria-pressed={reading}>{reading ? `${state.unread ? "New output · " : ""}Return to live` : "Pause to read"}</button> : null}
      </div>
    </div>
  </>;
}
