import { TerminalHost } from "./AgentPanel.js";
import { agentTone } from "./format.js";
import type { AgentTab, MountTerminal } from "./types.js";

export type StewardPanelProps = {
  /** The project's running Steward session, if any. */
  session: AgentTab | undefined;
  canStart: boolean;
  /** Steward resumes its earlier conversation. */
  resumable: boolean;
  focusLabel: string | undefined;
  mountTerminal: MountTerminal;
  onStart(): void;
  onStop(sessionId: string): void;
  /** Ends Steward's conversation and starts a new one. */
  onNewConversation(): void;
};

/** The right sidebar's "Steward" view: the project's one persistent assistant, beside whatever the stage shows. */
export function StewardPanel(props: StewardPanelProps) {
  const { session } = props;
  return (
    <section className="pane agent-pane steward-pane" aria-label="Steward">
      <div className="right-sidebar-tools">
        {session && <span className={`pane-dot ${agentTone(session.state, "assistant")}`} />}
        <span className="meta">{session ? `${session.provider} · ${session.detail}` : "not running"}</span>
        <span className="sp" />
        {(session || props.resumable) && (
          <button type="button" className="btn sm ghost" disabled={!props.canStart} title="End this conversation and start a new one" onClick={props.onNewConversation}>New conversation</button>
        )}
        {session && <button type="button" className="btn sm ghost" onClick={() => props.onStop(session.sessionId)}>Stop</button>}
      </div>
      {session ? (
        <>
          <TerminalHost key={session.sessionId} sessionId={session.sessionId} mountTerminal={props.mountTerminal} />
          <div className="agent-foot">Edits arrive as drafts. Nothing is written to Jira without you.</div>
        </>
      ) : (
        <div className="agent-empty">
          <p>Steward is not running.</p>
          <p className="hint">Steward reads the project's board, plans epics into tasks, and drafts descriptions, criteria and Playbook steps for you to review. It keeps one conversation and picks it up where it left off.</p>
          <button type="button" className="btn pri" disabled={!props.canStart} onClick={props.onStart}>
            {props.resumable ? "Resume Steward" : "Start Steward"}{props.focusLabel ? ` on ${props.focusLabel}` : ""}
          </button>
        </div>
      )}
    </section>
  );
}
