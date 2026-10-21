import { useMemo, useState } from "react";
import type { TaskWorktreeChangeEntryDto, TaskWorktreeUpstreamState } from "@termloop/contract/current";
import { sourceControlSections, type SourceControlSnapshot, type SourceControlSubject } from "../source-control-status.js";
import { ChangeBadge } from "./ChangeFileTree.js";
import { Icon } from "./Icon.js";
import "../../source-control.css";

const UPSTREAM_LABELS: Partial<Record<TaskWorktreeUpstreamState, string>> = {
  inSync: "Up to date",
  ahead: "Ahead of upstream",
  behind: "Behind upstream",
  diverged: "Diverged from upstream",
  notConfigured: "Not published",
  missing: "Upstream missing",
};

/// The right-hand Source Control panel: the checkout's branch, then its
/// changes grouped the way Orca groups them. Selecting a file opens the
/// existing read-only Changes review on that file.
export function SourceControlSidebar({ subject, projectName, tasks, selectedTaskId, snapshot, branch, upstream, selectRoot, refresh, openChange, openAll, close, unavailable }: {
  subject: SourceControlSubject | undefined;
  projectName: string | undefined;
  tasks: readonly { id: string; title: string }[];
  selectedTaskId: string | null;
  snapshot: SourceControlSnapshot;
  branch: string | undefined;
  upstream: TaskWorktreeUpstreamState | undefined;
  selectRoot(taskId: string | null): void;
  refresh(): void;
  openChange(entry: TaskWorktreeChangeEntryDto): void;
  openAll(): void;
  close(): void;
  unavailable: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const sections = useMemo(() => sourceControlSections(snapshot.result?.entries ?? []), [snapshot.result]);
  const total = snapshot.result?.entries.length ?? 0;
  const upstreamLabel = upstream ? UPSTREAM_LABELS[upstream] : undefined;
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return <aside className="files-sidebar source-control-sidebar" aria-label="Source Control">
    <header className="files-sidebar-header">
      <h2>Source Control</h2>
      <span className="source-control-header-actions">
        <button type="button" className="icon-button quiet" aria-label="Review all changes" title="Review all changes"
          aria-disabled={!subject || !total} onClick={() => { if (subject && total) openAll(); }}
        ><Icon name="external" /></button>
        <button type="button" className="icon-button quiet" aria-label="Refresh changes" title="Refresh changes"
          aria-disabled={!subject || snapshot.loading} onClick={() => { if (subject && !snapshot.loading) refresh(); }}
        ><Icon name="restart" /></button>
        <button type="button" className="icon-button quiet" aria-label="Close Source Control sidebar" title="Close Source Control sidebar" onClick={close}><Icon name="close" /></button>
      </span>
    </header>
    <div className="files-sidebar-section">
      <label className="files-root-picker"><select
        aria-label="Source Control root"
        value={selectedTaskId ?? ""}
        disabled={!subject}
        onChange={(event) => selectRoot(event.target.value || null)}
      >
        <option value="">{projectName ?? "Project"}</option>
        {tasks.length ? <optgroup label="Task worktrees">{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</optgroup> : null}
      </select><Icon name="chevronDown" /></label>
    </div>
    {subject ? <p className="source-control-branch" aria-label="Branch">
      <Icon name="branch" />
      <span className="source-control-branch-name">{branch ?? "Detached or unknown branch"}</span>
      {upstreamLabel ? <small data-upstream={upstream}>{upstreamLabel}</small> : null}
    </p> : null}
    <div className="files-sidebar-body">
      {!subject ? <p className="files-sidebar-empty">{unavailable ? "Connect to this computer to see its changes." : "Select a Project to see its changes."}</p>
        : !snapshot.result && snapshot.loading ? <p className="files-sidebar-empty" role="status">Loading changes…</p>
          : <>
            {snapshot.error ? <p className="files-tree-message error" role="alert">{snapshot.error}</p> : null}
            {snapshot.result && !total ? <p className="files-sidebar-empty">No changes in this checkout.</p> : null}
            {sections.map((section) => {
              const open = !collapsed.has(section.id);
              return <section key={section.id} className="source-control-section">
                <h3><button type="button" aria-expanded={open} onClick={() => toggle(section.id)}>
                  <Icon name="chevronDown" className={open ? undefined : "collapsed"} />
                  <span>{section.title}</span>
                  <b aria-label={`${section.entries.length} ${section.entries.length === 1 ? "file" : "files"}`}>{section.entries.length}</b>
                </button></h3>
                {open ? <ul aria-label={section.title}>
                  {section.entries.map((entry) => <li key={entry.entry_id}><SourceControlRow entry={entry} open={() => openChange(entry)} /></li>)}
                </ul> : null}
              </section>;
            })}
            {snapshot.result?.truncated ? <p className="files-tree-message">Only the first {total} changes are listed.</p> : null}
          </>}
    </div>
  </aside>;
}

function SourceControlRow({ entry, open }: { entry: TaskWorktreeChangeEntryDto; open(): void }) {
  const slash = entry.display_path.lastIndexOf("/");
  const name = entry.display_path.slice(slash + 1);
  const folder = slash > 0 ? entry.display_path.slice(0, slash) : "";
  const title = entry.original_display_path ? `${entry.original_display_path} → ${entry.display_path}` : entry.display_path;
  return <button type="button" className={`source-control-row status-${entry.kind}`} title={title} onClick={open}>
    <span className="source-control-row-name">{name}</span>
    {folder ? <small>{folder}</small> : null}
    <ChangeBadge entry={entry} />
  </button>;
}
