import { useEffect, useRef } from "react";
import type { PmAgentState } from "@termloop/pm-contract/pm";
import type { MountTerminal } from "./types.js";

export type AgentTab = { sessionId: string; label: string; state: PmAgentState; assistant: boolean };

export type AgentPanelProps = {
  tabs: AgentTab[];
  activeSessionId: string | undefined;
  canStart: boolean;
  focusLabel: string | undefined;
  mountTerminal: MountTerminal;
  onSelect(sessionId: string): void;
  onStop(sessionId: string): void;
  onStart(): void;
};

/** Running PM agents, one terminal at a time. Agent output is a draft. */
export function AgentPanel(props: AgentPanelProps) {
  const active = props.tabs.find((tab) => tab.sessionId === props.activeSessionId);
  const assistantRunning = props.tabs.some((tab) => tab.assistant);
  return (
    <aside className="pm-agent-panel" aria-label="Agents">
      <div className="pm-agent-tabs" role="tablist">
        {props.tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            key={tab.sessionId}
            aria-selected={tab.sessionId === props.activeSessionId}
            className={tab.sessionId === props.activeSessionId ? "active" : ""}
            onClick={() => props.onSelect(tab.sessionId)}
          >
            <span className={`pm-dot ${tab.state === "running" ? "ok" : "pending"}`} />
            {tab.label}
          </button>
        ))}
        {props.tabs.length > 0 && !assistantRunning && (
          <button type="button" className="pm-icon-button" title="Start PM agent" disabled={!props.canStart} onClick={props.onStart}>+</button>
        )}
      </div>
      {active ? (
        <>
          <TerminalHost key={active.sessionId} sessionId={active.sessionId} mountTerminal={props.mountTerminal} />
          <div className="pm-agent-foot">
            <span className="pm-muted">Agent edits arrive as drafts on the ticket; nothing is written to Jira without you.</span>
            <button type="button" className="pm-button" onClick={() => props.onStop(active.sessionId)}>Stop</button>
          </div>
        </>
      ) : (
        <div className="pm-agent-empty">
          <p>No agent is running.</p>
          <p className="pm-hint">The PM agent reads this project's board and drafts descriptions, criteria, and probes for you to review.</p>
          <button type="button" className="pm-button primary" disabled={!props.canStart} onClick={props.onStart}>
            Start PM agent{props.focusLabel ? ` on ${props.focusLabel}` : ""}
          </button>
        </div>
      )}
    </aside>
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
