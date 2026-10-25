import { useState } from "react";
import type { PmProject } from "@termloop/pm-contract/pm";
import type { PmView } from "./types.js";

export type HeaderProps = {
  projects: PmProject[];
  projectId: string | undefined;
  view: PmView;
  ticketSelected: boolean;
  jira: { configured: boolean; status: string };
  pulling: boolean;
  onSelectProject(projectId: string): void;
  onCreateProject(name: string): void;
  onView(view: PmView): void;
  onPull(): void;
};

export function Header(props: HeaderProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const project = props.projects.find((candidate) => candidate.id === props.projectId);
  const submit = () => {
    if (!name.trim()) return;
    props.onCreateProject(name.trim());
    setName("");
    setCreating(false);
  };
  return (
    <header className="pm-header">
      <div className="pm-brand">
        <span className="pm-brand-name">TermLoop PM</span>
        <span className="pm-brand-sep">/</span>
        {creating ? (
          <form className="pm-inline-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <input autoFocus aria-label="Project name" placeholder="Project name" value={name} onChange={(event) => setName(event.target.value)} />
            <button type="submit" className="pm-button primary">Create</button>
            <button type="button" className="pm-button ghost" onClick={() => setCreating(false)}>Cancel</button>
          </form>
        ) : (
          <>
            {props.projects.length > 0 ? (
              <select aria-label="Project" className="pm-project-select" value={project?.id ?? ""} onChange={(event) => props.onSelectProject(event.target.value)}>
                {props.projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            ) : <span className="pm-muted">No project</span>}
            <button type="button" className="pm-icon-button pm-project-add" title="New project" aria-label="New project" onClick={() => setCreating(true)}>+</button>
          </>
        )}
      </div>
      <nav className="pm-tabs" aria-label="Views">
        <button type="button" className={props.view === "overview" ? "active" : ""} onClick={() => props.onView("overview")}>Overview</button>
        <button type="button" className={props.view === "ticket" ? "active" : ""} disabled={!props.ticketSelected} onClick={() => props.onView("ticket")}>Ticket</button>
        <button type="button" className={props.view === "settings" ? "active" : ""} onClick={() => props.onView("settings")}>Settings</button>
      </nav>
      <div className="pm-jira-status">
        <span className={`pm-dot ${props.jira.configured ? "ok" : "off"}`} />
        <span className="pm-muted">{props.jira.status}</span>
        <button type="button" className="pm-button" disabled={!props.jira.configured || props.pulling || !project} onClick={props.onPull}>
          {props.pulling ? "Pulling…" : "Pull"}
        </button>
      </div>
    </header>
  );
}
