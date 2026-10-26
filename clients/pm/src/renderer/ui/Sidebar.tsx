import { Icon, type IconName } from "./icons.js";
import { ResizeHandle, type WidthBounds } from "./ResizeHandle.js";
import { ProjectSwitcher, type ProjectSwitcherProps } from "./ProjectSwitcher.js";
import { AgentRow } from "./AgentRow.js";
import { agentTone, relativeTime } from "./format.js";
import type { AgentTab, NavPage, PmView } from "./types.js";

export type SidebarProps = ProjectSwitcherProps & {
  view: PmView;
  hasProject: boolean;
  /** The sprint the board shows, named under the Board item. */
  boardSprint: string | undefined;
  counts: { sprints: number; epics: number; skills: number };
  jira: { configured: boolean; connected: boolean; status: string; lastPullEpochMs: number | undefined };
  pulling: boolean;
  now: number;
  /** Steward's running session, if any; it lives in the right sidebar. */
  steward: AgentTab | undefined;
  /** Every other running agent; each shows in the stage. */
  agents: AgentTab[];
  activeAgentSessionId: string | undefined;
  /** Shows the board, or a page, in the stage. */
  onNavigate(view: "overview" | NavPage): void;
  onNewTicket(): void;
  onPull(): void;
  onOpenSteward(): void;
  onSelectAgent(sessionId: string): void;
  onStopAgent(sessionId: string): void;
  /** Laid-out width; drags and arrow keys request a new one through `onResize`. */
  width: number;
  widthBounds: WidthBounds;
  onResize(width: number): void;
};

type NavItem = { view: "overview" | NavPage; label: string; icon: IconName; sub?: string | undefined; count?: number; disabled?: boolean; title?: string | undefined };

/**
 * The left column is navigation: project, the board and the pages, running
 * agents, then the rarely used configuration and the Jira sync status.
 */
export function Sidebar(props: SidebarProps) {
  const off = !props.hasProject;
  const primary: NavItem[] = [
    { view: "overview", label: "Board", icon: "board", sub: props.boardSprint, disabled: off },
    { view: "sprints", label: "Sprints", icon: "flag", count: props.counts.sprints, disabled: off },
    { view: "epics", label: "Epics", icon: "epic", count: props.counts.epics, disabled: off },
    {
      view: "jira",
      label: "Jira issues",
      icon: "jira",
      disabled: off || !props.jira.connected,
      title: props.jira.connected ? undefined : "Connect Jira in Settings",
    },
  ];
  const configure: NavItem[] = [
    { view: "playbook", label: "Playbook", icon: "playbook", disabled: off },
    { view: "skills", label: "Skills", icon: "skill", count: props.counts.skills, disabled: off },
    { view: "settings", label: "Settings", icon: "gear", disabled: off },
  ];
  const item = (entry: NavItem) => {
    const current = props.view === entry.view;
    return (
      <button
        key={entry.view}
        type="button"
        className={`nav-item ${current ? "on" : ""}`}
        aria-current={current ? "page" : undefined}
        disabled={entry.disabled}
        title={entry.title}
        onClick={() => props.onNavigate(entry.view)}
      >
        <Icon name={entry.icon} />
        <span className="nav-label">{entry.label}</span>
        {entry.sub && <span className="nav-sub">{entry.sub}</span>}
        {entry.count !== undefined && entry.count > 0 && <span className="nav-count">{entry.count}</span>}
      </button>
    );
  };
  const steward = props.steward;
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <ResizeHandle edge="right" label="sidebar" width={props.width} bounds={props.widthBounds} onResize={props.onResize} />
      <div className="brand">
        <span className="logo" />
        <b>TermLoop PM</b>
      </div>
      <ProjectSwitcher projects={props.projects} projectId={props.projectId} onSelectProject={props.onSelectProject} onCreateProject={props.onCreateProject} />
      <button type="button" className="new-ticket" disabled={off} title="New ticket (⇧⇧ or ⌘N)" onClick={props.onNewTicket}>
        <Icon name="plus" /><span>New ticket</span><kbd>⇧⇧</kbd>
      </button>
      <div className="sidebar-scroll">
        <nav className="nav" aria-label="Pages">{primary.map(item)}</nav>
        <section className="nav-section" aria-label="Agents">
          <h2 className="nav-heading">Agents{props.agents.length > 0 && <span className="n">{props.agents.length + (steward ? 1 : 0)}</span>}</h2>
          <button type="button" className="row steward-row" disabled={off} onClick={props.onOpenSteward}>
            <span className={`dot ${steward ? agentTone(steward.state, "assistant") : ""}`} />
            <span className="copy">
              <span className="row-title">Steward</span>
              <span className="row-sub">{steward ? <><span className={steward.provider}>{steward.provider === "claude" ? "Claude" : "Codex"}</span><span>{steward.detail}</span></> : <span>plans, drafts, and splits epics</span>}</span>
            </span>
            <span />
          </button>
          {props.agents.map((agent) => (
            <AgentRow
              key={agent.sessionId}
              agent={agent}
              shown={props.view === "agent" && agent.sessionId === props.activeAgentSessionId}
              sub={agent.detail}
              onSelect={() => props.onSelectAgent(agent.sessionId)}
              onStop={() => props.onStopAgent(agent.sessionId)}
            />
          ))}
        </section>
      </div>
      <nav className="nav nav-bottom" aria-label="Configuration">{configure.map(item)}</nav>
      <div className="sidebar-footer">
        <span className={`fchip ${props.jira.configured ? "" : "off"}`} title={props.jira.status}>
          <i />{props.jira.configured ? `Jira ${props.jira.lastPullEpochMs !== undefined ? relativeTime(props.jira.lastPullEpochMs, props.now) : "not pulled"}` : "Jira off"}
        </span>
        <span />
        <button type="button" className="icb" title="Pull from Jira" aria-label="Pull from Jira" disabled={!props.jira.configured || props.pulling || off} onClick={props.onPull}>
          <Icon name="refresh" />
        </button>
      </div>
    </aside>
  );
}
