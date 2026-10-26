import { useEffect, useRef } from "react";
import { agentTone } from "./format.js";
import type { AgentTab, MountTerminal } from "./types.js";

export type { AgentTab } from "./types.js";

export type AgentPanelProps = {
  tabs: AgentTab[];
  activeSessionId: string | undefined;
  canStart: boolean;
  focusLabel: string | undefined;
  mountTerminal: MountTerminal;
  onStop(sessionId: string): void;
  onStart(): void;
};

/** The stage's terminal pane: one agent at full size, picked under its ticket in the sidebar. Agent output is a draft. */
export function AgentPanel(props: AgentPanelProps) {
  const active = props.tabs.find((tab) => tab.sessionId === props.activeSessionId);
  return (
    <section className="pane agent-pane" aria-label="Agents">
      <div className="pane-head">
        {active && <span className={`pane-dot ${agentTone(active.state, active.assistant ? "assistant" : "deliveryCheck")}`} />}
        <b>{active ? active.label : "Assistant"}</b>
        <span className="meta">{active ? `${active.provider} · ${active.detail}` : "not running"}</span>
        <span className="sp" />
        {active
          ? <button type="button" className="btn sm ghost" onClick={() => props.onStop(active.sessionId)}>Stop</button>
          : props.tabs.length === 0 ? null : <span className="meta">{props.tabs.length} running</span>}
      </div>
      {active ? (
        <>
          <TerminalHost key={active.sessionId} sessionId={active.sessionId} mountTerminal={props.mountTerminal} />
          <div className="agent-foot">Edits arrive as drafts on the ticket. Nothing is written to Jira without you.</div>
        </>
      ) : (
        <div className="agent-empty">
          <p>No assistant is running.</p>
          <p className="hint">The assistant reads this project's board and drafts descriptions, criteria and Playbook steps for you to review.</p>
          <button type="button" className="btn pri" disabled={!props.canStart} onClick={props.onStart}>
            Start assistant{props.focusLabel ? ` on ${props.focusLabel}` : ""}
          </button>
        </div>
      )}
    </section>
  );
}

function TerminalHost(props: { sessionId: string; mountTerminal: MountTerminal }) {
  const host = useRef<HTMLDivElement>(null);
  const { sessionId, mountTerminal } = props;
  useEffect(() => {
    if (!host.current) return;
    return mountTerminal(host.current, sessionId);
  }, [sessionId, mountTerminal]);
  return <div className="pm-terminal-host" ref={host} data-session-id={sessionId} />;
}
