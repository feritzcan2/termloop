import { useEffect, useRef, useState } from "react";
import type { PmProject } from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";

export type ProjectSwitcherProps = {
  projects: PmProject[];
  projectId: string | undefined;
  onSelectProject(projectId: string): void;
  onCreateProject(name: string): void;
};

/** The sidebar's project trigger and its menu of projects plus "New project". */
export function ProjectSwitcher(props: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const project = props.projects.find((candidate) => candidate.id === props.projectId);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const submit = () => {
    if (!name.trim()) return;
    props.onCreateProject(name.trim());
    setName("");
    setCreating(false);
  };
  return (
    <div className="project-switcher" ref={root} onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); setCreating(false); } }}>
      <span className="project-label">Project</span>
      {creating ? (
        <form className="project-create" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <input autoFocus aria-label="Project name" placeholder="Project name" value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="btn sm pri" disabled={!name.trim()}>Create</button>
          <button type="button" className="btn sm ghost" onClick={() => setCreating(false)}>Cancel</button>
        </form>
      ) : (
        <button
          type="button"
          className="project-trigger"
          aria-label="Project"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => (props.projects.length > 0 ? setOpen(!open) : setCreating(true))}
        >
          <span className="project-avatar">{(project?.name ?? "+").slice(0, 1).toUpperCase()}</span>
          <strong>{project?.name ?? "New project"}</strong>
          <Icon name="down" />
        </button>
      )}
      {open && (
        <div role="menu" className="pm-menu project-menu">
          {props.projects.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="menuitemradio"
              aria-checked={candidate.id === props.projectId}
              className={candidate.id === props.projectId ? "current" : ""}
              onClick={() => { setOpen(false); if (candidate.id !== props.projectId) props.onSelectProject(candidate.id); }}
            >
              <span className="project-avatar">{candidate.name.slice(0, 1).toUpperCase()}</span>
              <span>{candidate.name}</span>
            </button>
          ))}
          <button type="button" role="menuitem" className="project-new" onClick={() => { setOpen(false); setCreating(true); }}>
            <Icon name="plus" /><span>New project</span>
          </button>
        </div>
      )}
    </div>
  );
}
