import type { Session } from "../model.js";
import { sessionLabel } from "../model.js";
import { Icon } from "./Icon.js";

export type SessionTabStripProps = {
  sessions: readonly Session[];
  selectedSessionId: string | undefined;
  disabled: boolean;
  selectSession(sessionId: string): void;
  launchTerminal(): Promise<void>;
};

export function SessionTabStrip(props: SessionTabStripProps) {
  return (
    <nav className="session-tab-strip" aria-label="Project Sessions">
      <div className="session-tab-list" role="tablist">
        {props.sessions.map((session) => {
          const selected = session.id === props.selectedSessionId;
          return (
            <button
              key={session.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={selected ? "selected" : ""}
              title={sessionLabel(session)}
              onClick={() => props.selectSession(session.id)}
            >
              <Icon name={session.kind === "Agent" ? "agent" : "terminal"} />
              <span>{sessionLabel(session)}</span>
              <i className={`session-tab-state ${session.lifecycle_state}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <button
        className="session-tab-add"
        type="button"
        aria-label="New terminal"
        title="New terminal"
        disabled={props.disabled}
        onClick={() => { void props.launchTerminal(); }}
      >
        <Icon name="add" />
      </button>
    </nav>
  );
}
