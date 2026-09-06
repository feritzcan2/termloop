import { Icon, type IconName } from "./Icon.js";
import type { AgentCapabilityDto } from "@termloop/contract/current";
import type { WorkspaceView } from "../workspace-view-memory.js";

export type { WorkspaceView } from "../workspace-view-memory.js";

export function WorkspaceViewSwitch({ view, viewActive = true, disabled, agents = [], select, launchTerminal, launchAgent, setupDevServer, runDevServer, attentionCount = 0, taskAttentionCount = 0, viewAction, secondaryAction }: {
  view: WorkspaceView;
  /// False while another rail (Skills, MCP, Prompts) owns the sidebar: the bar
  /// keeps its place and its launch actions, but no tab claims to be showing
  /// what is below it.
  viewActive?: boolean;
  disabled: boolean;
  agents?: readonly AgentCapabilityDto[];
  select(view: WorkspaceView): void;
  launchTerminal(): Promise<void>;
  launchAgent(agentId: string): Promise<void>;
  /// Present only until this Project has a dev server to run. It states the
  /// whole offer in words because nothing on screen has taught the icon yet.
  setupDevServer?: (() => void) | undefined;
  /// Replaces that offer once the dev server exists: the same slot, now a bare
  /// RUN button that starts it in the Project's own checkout. A Project has one
  /// dev server, so the slot itself identifies it and the name it runs lives in
  /// the tooltip and the accessible label instead of spending rail width.
  /// `edit` opens its settings — the only Project-level route to them, and to
  /// Improve with agent.
  runDevServer?: { name: string; running: boolean; start(): void; edit(): void } | undefined;
  /// Live agents waiting on the user. Every tab marks waiting work with the
  /// same dot rather than a number: the count is for assistive technology,
  /// the glance only needs to know that someone is waiting.
  attentionCount?: number;
  /// The subset of those agents running inside a Task, so the Tasks tab lights
  /// up too even while another view has the rail.
  taskAttentionCount?: number;
  /// The selected view's one primary action — Create Task, agent search —
  /// rendered beside the tabs. The rails below carry no title row of their
  /// own, so this slot is where those actions live. The bar is two rows: the
  /// tabs and this action say what the rail shows; the launch row beneath
  /// (RUN, terminal, agents, history) starts something and belongs to the
  /// Project, not to a view. One row could not hold both at the default width.
  viewAction?: { label: string; icon: IconName; run(): void; pressed?: boolean; disabled?: boolean } | undefined;
  /// A quieter Project-level companion to the primary action — the Tasks view
  /// uses it for Task Sources, the page that feeds the list from Jira.
  secondaryAction?: { label: string; icon: IconName; run(): void; pressed?: boolean; disabled?: boolean } | undefined;
}) {
  const selected = (candidate: WorkspaceView) => viewActive && view === candidate;
  return (
    <div className="workspace-view-bar">
      <div className="workspace-view-row">
        <div className="workspace-view-switch" role="tablist" aria-label="Workspace view">
          <button
            type="button"
            role="tab"
            aria-label="All active agents view"
            aria-selected={selected("agents")}
            className={selected("agents") ? "selected" : undefined}
            title="All active agents"
            onClick={() => select("agents")}
          ><Icon name="agent" /><span className="workspace-view-label">Agents</span>{attentionCount > 0 ? <span className="workspace-view-attention" role="img" aria-label={`${attentionCount} agents need you`} /> : null}</button>
          <button
            type="button"
            role="tab"
            aria-label="Tasks and Sessions view"
            aria-selected={selected("overview")}
            className={selected("overview") ? "selected" : undefined}
            title="Tasks and Sessions"
            onClick={() => select("overview")}
          ><Icon name="task" /><span className="workspace-view-label">Tasks</span>{taskAttentionCount > 0 ? <span className="workspace-view-attention" role="img" aria-label={`${taskAttentionCount} Tasks need you`} /> : null}</button>
          <button
            type="button"
            role="tab"
            aria-label="Project architecture map"
            aria-selected={selected("map")}
            className={selected("map") ? "selected" : undefined}
            title="Architecture map"
            onClick={() => select("map")}
          ><Icon name="branch" /><span className="workspace-view-label">Map</span></button>
          <button
            type="button"
            role="tab"
            aria-label="Project Steward view"
            aria-selected={selected("steward")}
            className={selected("steward") ? "selected" : undefined}
            title="Project Steward and Playbook"
            onClick={() => select("steward")}
          ><span className="workspace-view-glyph" aria-hidden="true">✦</span><span className="workspace-view-label">Steward</span></button>
      </div>
      {secondaryAction ? (
        <button
          type="button"
          className="workspace-view-action secondary"
          title={secondaryAction.label}
          aria-label={secondaryAction.label}
          aria-pressed={secondaryAction.pressed}
          disabled={secondaryAction.disabled}
          onClick={secondaryAction.run}
        ><Icon name={secondaryAction.icon} /></button>
      ) : null}
      {viewAction ? (
        <button
          type="button"
          className="workspace-view-action"
          title={viewAction.label}
          aria-label={viewAction.label}
          aria-pressed={viewAction.pressed}
          disabled={viewAction.disabled}
          onClick={viewAction.run}
        ><Icon name={viewAction.icon} /></button>
      ) : null}
      </div>
      {view === "steward" || view === "map" ? null : <div className="workspace-launch-actions" aria-label="Launch Session">
        {setupDevServer ? (
          <button
            type="button"
            className="setup-dev-server"
            title="Describe this Project's dev server once, then start it here or in any Task"
            disabled={disabled}
            onClick={setupDevServer}
          ><Icon name="play" />Set up dev server</button>
        ) : runDevServer ? (
          <span className="run-dev-server-chip">
            <button
              type="button"
              className={`setup-dev-server run-dev-server${runDevServer.running ? " running" : ""}`}
              title={runDevServer.running
                ? `${runDevServer.name} is already running in this Project's checkout — opens its terminal`
                : `Start ${runDevServer.name} in this Project's own checkout`}
              aria-label={runDevServer.running
                ? `Open the running ${runDevServer.name}`
                : `Run ${runDevServer.name} in this Project's own checkout`}
              disabled={disabled}
              onClick={runDevServer.start}
              onContextMenu={(event) => { event.preventDefault(); runDevServer.edit(); }}
            >{runDevServer.running
              ? <span className="run-dev-server-dot" aria-hidden="true" />
              : <Icon name="play" />}<span className="run-dev-server-label">RUN</span></button>
            <button
              type="button"
              className="run-dev-server-edit"
              title={`Edit ${runDevServer.name}`}
              aria-label={`Edit run configuration ${runDevServer.name}`}
              disabled={disabled}
              onClick={runDevServer.edit}
            ><Icon name="edit" /></button>
          </span>
        ) : null}
        <button id="new-terminal" type="button" title="New Terminal" aria-label="New Terminal" disabled={disabled} onClick={() => void launchTerminal()}><Icon name="terminal" /></button>
        {agents.map((agent) => {
          const icon = agent.agent_id === "claude" ? "claude" : agent.agent_id === "codex" ? "codex" : "agent";
          const title = !agent.available
            ? `${agent.label} CLI unavailable`
            : `New ${agent.label} Session${agent.integration_level === "launchOnly" ? " (launch only)" : ""}`;
          return <button
            key={agent.agent_id}
            type="button"
            className={agent.agent_id}
            title={title}
            aria-label={title}
            disabled={disabled || !agent.available}
            onClick={() => void launchAgent(agent.agent_id)}
          ><Icon name={icon} /></button>;
        })}
        <span className="workspace-history-separator" aria-hidden="true" />
        <button
          type="button"
          className={`workspace-history${selected("history") ? " selected" : ""}`}
          title="Session History"
          aria-label="Session History"
          aria-pressed={selected("history")}
          onClick={() => select("history")}
        ><Icon name="history" /></button>
      </div>}
    </div>
  );
}
