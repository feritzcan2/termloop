import { Icon } from "./icons.js";
import { agentTone } from "./format.js";
import type { AgentTab } from "./types.js";

/**
 * One sidebar agent: picking it shows its terminal in the stage; a live agent
 * carries a stop button over the row's end column.
 */
export function AgentRow(props: {
  agent: AgentTab;
  shown: boolean;
  /** The second line after the provider, e.g. the agent's state or focus. */
  sub: string;
  className?: string;
  onSelect(): void;
  onStop: (() => void) | undefined;
}) {
  const { agent } = props;
  const live = agent.state !== "exited";
  return (
    <div className="pm-agent-item">
      <button
        type="button"
        className={`row ${props.className ?? ""} ${props.shown ? "active" : ""}`}
        aria-current={props.shown ? "true" : undefined}
        onClick={props.onSelect}
      >
        <span className={`dot ${agentTone(agent.state, agent.assistant ? "assistant" : "deliveryCheck")}`} />
        <span className="copy">
          <span className="row-title">{agent.label}</span>
          <span className="row-sub"><span className={agent.provider}>{agent.provider === "claude" ? "Claude" : "Codex"}</span><span>{props.sub}</span></span>
        </span>
        <span />
      </button>
      {live && props.onStop && (
        <button type="button" className="icb pm-agent-stop" title={`Stop ${agent.label}`} aria-label={`Stop ${agent.label}`} onClick={props.onStop}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}
