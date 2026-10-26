import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";
import { ResizeHandle, type WidthBounds } from "./ResizeHandle.js";
import { ProjectSwitcher, type ProjectSwitcherProps } from "./ProjectSwitcher.js";
import { SprintSidebar, type SprintComposer, type SprintSidebarProps } from "./SprintSidebar.js";
import { AgentRow } from "./AgentRow.js";
import { relativeTime } from "./format.js";
import type { AgentTab, PmView } from "./types.js";

export type SidebarProps = ProjectSwitcherProps &
  Omit<SprintSidebarProps, "collapsed" | "onToggle" | "composer" | "onComposer"> & {
    view: PmView;
    hasProject: boolean;
    jira: { configured: boolean; status: string; lastPullEpochMs: number | undefined };
    pulling: boolean;
    now: number;
    agents: AgentTab[];
    activeAgentSessionId: string | undefined;
    onPull(): void;
    onStartAssistant(): void;
    onSelectAgent(sessionId: string): void;
    onStopAgent(sessionId: string): void;
    /** Laid-out width; drags and arrow keys request a new one through `onResize`. */
    width: number;
    widthBounds: WidthBounds;
    onResize(width: number): void;
  };

type Mode = "sprints" | "agents";

/** The TermLoop-style left column: brand, project, view bar, rails, footer. */
export function Sidebar(props: SidebarProps) {
  const [mode, setMode] = useState<Mode>("sprints");
  const [composer, setComposer] = useState<SprintComposer>(undefined);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const toggle = (rail: string) => setFolded((current) => ({ ...current, [rail]: !current[rail] }));
  const drafts = props.tickets.some((entry) => entry.pendingProposalCount > 0);
  const pickMode = (next: Mode) => {
    setMode(next);
    setFolded((current) => ({ ...current, sprints: next === "agents", agents: false }));
  };
  const shownAgent = props.view === "agent" ? props.activeAgentSessionId : undefined;
  const sprintsRail = (
    <SprintSidebar
      {...props}
      shownAgentSessionId={shownAgent}
      collapsed={folded.sprints ?? false}
      onToggle={() => toggle("sprints")}
      composer={composer}
      onComposer={setComposer}
    />
  );
  const agentsRail = (
    <Rail key="agents" glyph="agent" title="Active Agents" count={props.agents.length} folded={folded.agents ?? false} onToggle={() => toggle("agents")}
      meta={drafts ? "draft waiting" : undefined}>
      {props.agents.length === 0 ? <p className="rail-empty">No agent is running.</p> : (
        <div className="list">
          {props.agents.map((agent) => (
            <AgentRow
              key={agent.sessionId}
              agent={agent}
              shown={agent.sessionId === shownAgent}
              sub={agent.detail}
              onSelect={() => props.onSelectAgent(agent.sessionId)}
              onStop={() => props.onStopAgent(agent.sessionId)}
            />
          ))}
        </div>
      )}
    </Rail>
  );
  return (
    <aside className="sidebar" aria-label="Sidebar">
      <ResizeHandle edge="right" label="sidebar" width={props.width} bounds={props.widthBounds} onResize={props.onResize} />
      <div className="brand">
        <span className="logo" />
        <b>TermLoop PM</b>
        <span className={`chip ${props.jira.configured ? "" : "off"}`} title={props.jira.status}><i />Jira</span>
        <span className="ic">
          <button type="button" className="icb" aria-label="Search" title="Search (not available yet)" disabled><Icon name="search" /></button>
          <button
            type="button"
            className="icb"
            aria-label="New ticket"
            title="New ticket in the selected sprint"
            disabled={!props.hasProject}
            onClick={() => { pickMode("sprints"); setFolded((current) => ({ ...current, sprints: false })); setComposer("ticket"); }}
          >
            <Icon name="plus" />
          </button>
        </span>
      </div>
      <ProjectSwitcher projects={props.projects} projectId={props.projectId} onSelectProject={props.onSelectProject} onCreateProject={props.onCreateProject} />
      <div className="view-bar">
        <div className="view-row">
          <div className="view-switch" role="group" aria-label="Sidebar view">
            <button type="button" className={mode === "sprints" ? "selected" : ""} aria-pressed={mode === "sprints"} onClick={() => pickMode("sprints")}>
              <Icon name="flag" /><span>Sprints</span>
            </button>
            <button type="button" className={mode === "agents" ? "selected" : ""} aria-pressed={mode === "agents"} onClick={() => pickMode("agents")}>
              <Icon name="agent" /><span>Agents</span>{drafts && <span className="att" title="An assistant draft is waiting" />}
            </button>
          </div>
          <button type="button" className="view-action" disabled={!props.hasProject} onClick={() => { pickMode("sprints"); setComposer("sprint"); }}>
            <Icon name="plus" />New sprint
          </button>
        </div>
        <div className="launch-row">
          <button type="button" className="icb" title="Pull from Jira" aria-label="Pull from Jira" disabled={!props.jira.configured || props.pulling || !props.hasProject} onClick={props.onPull}>
            <Icon name="refresh" />
          </button>
          <button type="button" className="icb claude" title="Open Steward" aria-label="Open Steward" disabled={!props.hasProject} onClick={props.onStartAssistant}>
            <Icon name="agent" />
          </button>
        </div>
      </div>
      <div className="sidebar-scroll">
        {mode === "agents" ? <>{agentsRail}{sprintsRail}</> : <>{sprintsRail}{agentsRail}</>}
      </div>
      <div className="sidebar-footer">
        <span className={`fchip ${props.jira.configured ? "" : "off"}`} title={props.jira.status}>
          <i />{props.jira.configured ? `Jira ${props.jira.lastPullEpochMs !== undefined ? relativeTime(props.jira.lastPullEpochMs, props.now) : "not pulled"}` : "Jira off"}
        </span>
        <span />
        <button type="button" className="fchip pri" disabled={!props.jira.configured || props.pulling || !props.hasProject} onClick={props.onPull}>
          {props.pulling ? "Pulling…" : "Pull"}
        </button>
      </div>
    </aside>
  );
}

function Rail(props: { glyph: IconName; title: string; count: number; meta?: string | undefined; folded: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <section className="rail" aria-label={props.title}>
      <div className="rail-header" onClick={props.onToggle}>
        <span className="tg"><Icon name={props.folded ? "right" : "down"} /></span>
        <span className="gl"><Icon name={props.glyph} /></span>
        <h2>{props.title}</h2>
        <span className="meta">{props.meta}<span className="count-badge">{props.count}</span></span>
        <span />
      </div>
      {!props.folded && props.children}
    </section>
  );
}
