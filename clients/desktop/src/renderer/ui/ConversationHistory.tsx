import { useEffect, useRef } from "react";
import type { ConversationPort, ConversationState } from "../terminal-presentation.js";

export function ConversationHistory({ sessionId, state, port }: {
  sessionId: string; state: ConversationState; port: ConversationPort;
}) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo?.(0, 0); }, [state.page]);
  useEffect(() => { body.current?.focus(); }, []);
  return <section className="terminal-conversation-view" aria-label="Saved conversation messages">
    <header>
      <div><strong>Saved messages</strong><p>User and assistant messages · the session keeps running</p></div>
      <button type="button" onClick={() => port.close(sessionId)}>Return to terminal</button>
    </header>
    <div className="terminal-conversation-messages" ref={body} tabIndex={0} aria-busy={state.loading}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); port.close(sessionId); } }}>
      {state.loading ? <p role="status">Loading saved messages…</p> : null}
      {state.error ? <p role="alert">{state.error} <button type="button" onClick={() => port.retry(sessionId)}>Try again</button></p> : null}
      {!state.loading && !state.error && state.page?.status === "unavailable" ? <p role="status">Saved messages are unavailable for this session. The provider may have moved or removed the conversation. <button type="button" onClick={() => port.retry(sessionId)}>Try again</button></p> : null}
      {!state.loading && !state.error && state.page?.status === "available" ? <>
        {state.page.incomplete ? <p role="status">Some records could not be read completely.</p> : null}
        {state.page.messages.length === 0 ? <p>No user or assistant messages in this part of the conversation.</p> : null}
        {state.page.messages.map((message, index) => <article key={index}>
          <h3>{message.role === "user" ? "You" : "Assistant"}</h3>
          <pre>{message.text}</pre>
          {message.truncated ? <p>This long message is shortened.</p> : null}
        </article>)}
      </> : null}
    </div>
    <footer>
      <button type="button" disabled={state.loading || Boolean(state.error) || state.page?.next_before == null} onClick={() => port.older(sessionId)}>Older messages</button>
      {!state.loading && state.page?.status === "available" && state.page.next_before === null ? <span>Start of saved conversation</span> : null}
      <button type="button" disabled={state.loading || !state.hasNewer} onClick={() => port.newer(sessionId)}>Newer messages</button>
    </footer>
  </section>;
}
