import { useMemo, useState } from "react";
import type { TaskWorktreeChangeEntryDto } from "@termloop/contract/current";
import {
  sourceControlPrimary,
  sourceControlSections,
  type SourceControlAction,
  type SourceControlSection,
  type SourceControlSnapshot,
  type SourceControlStatus,
  type SourceControlSubject,
} from "../source-control-status.js";
import { ChangeBadge } from "./ChangeFileTree.js";
import { Icon, type IconName } from "./Icon.js";
import "../../source-control.css";

type Entries = readonly TaskWorktreeChangeEntryDto[];
export type SourceControlActions = Pick<SourceControlStatus, "refresh" | "stage" | "unstage" | "discard" | "commit" | "sync">;

const BUSY_LABELS: Record<SourceControlAction, string> = {
  stage: "Staging…",
  unstage: "Unstaging…",
  discard: "Discarding…",
  commit: "Committing…",
  push: "Pushing…",
  pull: "Pulling…",
  fetch: "Fetching…",
};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/// The right-hand Source Control panel: the checkout's branch, a commit box,
/// and its changes grouped the way Orca groups them, each with the actions
/// Git allows on it. Selecting a file opens the Changes review on that file.
export function SourceControlSidebar({ subject, projectName, tasks, selectedTaskId, snapshot, actions, selectRoot, openChange, openAll, close, unavailable }: {
  subject: SourceControlSubject | undefined;
  projectName: string | undefined;
  tasks: readonly { id: string; title: string }[];
  selectedTaskId: string | null;
  snapshot: SourceControlSnapshot;
  actions: SourceControlActions;
  selectRoot(taskId: string | null): void;
  openChange(entry: TaskWorktreeChangeEntryDto): void;
  openAll(): void;
  close(): void;
  unavailable: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const sections = useMemo(() => sourceControlSections(snapshot.result?.entries ?? []), [snapshot.result]);
  const total = snapshot.result?.entries.length ?? 0;
  const branch = snapshot.result?.branch;
  const busy = snapshot.busy;
  const stagedCount = sections.find((section) => section.id === "staged")?.entries.length ?? 0;
  const primary = sourceControlPrimary(branch, stagedCount, Boolean(message.trim()));
  const hasUpstream = Boolean(branch?.upstream && !branch.upstream_gone);
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const commit = async (thenPush = false) => {
    if (await actions.commit(message, thenPush)) setMessage("");
  };
  const discard = (entries: Entries) => {
    const untracked = entries.filter((entry) => entry.side === "untracked").length;
    const label = entries.length === 1 ? entries[0]!.display_path : `${entries.length} files`;
    const prompt = untracked === entries.length
      ? `Delete ${label}? This file is not tracked by Git and cannot be restored.`
      : `Discard changes in ${label}? This cannot be undone.`;
    if (window.confirm(prompt)) void actions.discard(entries);
  };
  const runPrimary = () => {
    if (busy) return;
    if (primary.kind === "commit") { if (primary.enabled) void commit(); return; }
    if (primary.kind === "publish" || primary.kind === "push") void actions.sync("push");
    if (primary.kind === "pull") void actions.sync("pull");
    if (primary.kind === "sync") void actions.sync("pull").then((pulled) => { if (pulled) void actions.sync("push"); });
  };
  const menu = (action: () => unknown) => () => { setMenuOpen(false); if (!busy) void action(); };

  return <aside className="files-sidebar source-control-sidebar" aria-label="Source Control" aria-busy={Boolean(busy)}>
    <header className="files-sidebar-header">
      <h2>Source Control</h2>
      <span className="source-control-header-actions">
        <button type="button" className="icon-button quiet" aria-label="Review all changes" title="Review all changes"
          aria-disabled={!subject || !total} onClick={() => { if (subject && total) openAll(); }}
        ><Icon name="external" /></button>
        <button type="button" className="icon-button quiet" aria-label="Refresh changes" title="Refresh changes"
          aria-disabled={!subject || snapshot.loading} onClick={() => { if (subject && !snapshot.loading) void actions.refresh(); }}
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
    {subject && branch ? <p className="source-control-branch" aria-label="Branch">
      <Icon name="branch" />
      <span className="source-control-branch-name">{branch.name ?? "Detached HEAD"}</span>
      <BranchSync branch={branch} />
    </p> : null}
    {subject && snapshot.result ? <div className="source-control-commit">
      <textarea
        aria-label="Commit message"
        placeholder={`Message (${isMac() ? "⌘" : "Ctrl"}+Enter to commit)`}
        rows={Math.min(6, Math.max(1, message.split("\n").length))}
        value={message}
        disabled={Boolean(busy)}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          if (stagedCount && message.trim() && !busy) void commit();
        }}
      />
      <div className="source-control-primary">
        <button type="button" className="source-control-primary-main"
          aria-disabled={Boolean(busy) || primary.kind === "none" || (primary.kind === "commit" && !primary.enabled)}
          title={primaryTitle(primary, stagedCount)} onClick={runPrimary}
        >{busy ? BUSY_LABELS[busy] : <PrimaryLabel primary={primary} />}</button>
        <button type="button" className="source-control-primary-more" aria-label="More Source Control actions" aria-haspopup="menu"
          aria-expanded={menuOpen} disabled={Boolean(busy)} onClick={() => setMenuOpen((open) => !open)}
        ><Icon name="chevronDown" /></button>
        {menuOpen ? <>
          <button type="button" tabIndex={-1} className="context-menu-backdrop" aria-label="Close Source Control actions" onClick={() => setMenuOpen(false)} />
          <div className="context-menu source-control-menu" role="menu" aria-label="Source Control actions"
            onKeyDown={(event) => { if (event.key === "Escape") setMenuOpen(false); }}>
            <MenuItem icon="check" label="Commit" disabled={!stagedCount || !message.trim()} run={menu(() => commit())} />
            <MenuItem icon="upload" label={hasUpstream ? "Commit & Push" : "Commit & Publish"} disabled={!stagedCount || !message.trim()} run={menu(() => commit(true))} />
            <div className="context-menu-divider" role="separator" />
            <MenuItem icon="upload" label={hasUpstream ? "Push" : "Publish Branch"} disabled={branch?.head_state !== "attached"} run={menu(() => actions.sync("push"))} />
            <MenuItem icon="download" label="Pull" disabled={!hasUpstream} run={menu(() => actions.sync("pull"))} />
            <MenuItem icon="restart" label="Fetch" run={menu(() => actions.sync("fetch"))} />
          </div>
        </> : null}
      </div>
      {snapshot.actionError ? <p className="files-tree-message error" role="alert">{snapshot.actionError}</p> : null}
    </div> : null}
    <div className="files-sidebar-body">
      {!subject ? <p className="files-sidebar-empty">{unavailable ? "Connect to this computer to see its changes." : "Select a Project to see its changes."}</p>
        : !snapshot.result && snapshot.loading ? <p className="files-sidebar-empty" role="status">Loading changes…</p>
          : <>
            {snapshot.error ? <p className="files-tree-message error" role="alert">{snapshot.error}</p> : null}
            {snapshot.result && !total ? <p className="files-sidebar-empty">No changes in this checkout.</p> : null}
            {sections.map((section) => {
              const open = !collapsed.has(section.id);
              return <section key={section.id} className="source-control-section">
                <h3>
                  <button type="button" aria-expanded={open} onClick={() => toggle(section.id)}>
                    <Icon name="chevronDown" className={open ? undefined : "collapsed"} />
                    <span>{section.title}</span>
                  </button>
                  <span className="source-control-actions">
                    <SectionActions section={section} disabled={Boolean(busy)} actions={actions} discard={discard} />
                  </span>
                  <b aria-label={`${section.entries.length} ${section.entries.length === 1 ? "file" : "files"}`}>{section.entries.length}</b>
                </h3>
                {open ? <ul aria-label={section.title}>
                  {section.entries.map((entry) => <li key={entry.entry_id} className="source-control-item">
                    <SourceControlRow entry={entry} open={() => openChange(entry)} />
                    <span className="source-control-actions">
                      <RowActions section={section.id} entry={entry} disabled={Boolean(busy)} actions={actions} discard={discard} />
                    </span>
                  </li>)}
                </ul> : null}
              </section>;
            })}
            {snapshot.result?.truncated ? <p className="files-tree-message">Only the first {total} changes are listed.</p> : null}
          </>}
    </div>
  </aside>;
}

function BranchSync({ branch }: { branch: NonNullable<SourceControlSnapshot["result"]>["branch"] }) {
  if (branch.head_state === "detached") return null;
  if (!branch.upstream) return <small data-upstream="notConfigured">Not published</small>;
  if (branch.upstream_gone) return <small data-upstream="missing" title={branch.upstream}>Upstream gone</small>;
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  const label = ahead || behind ? `${behind ? `↓${behind}` : ""}${ahead && behind ? " " : ""}${ahead ? `↑${ahead}` : ""}` : "Up to date";
  return <small data-upstream={ahead && behind ? "diverged" : behind ? "behind" : ahead ? "ahead" : "inSync"} title={branch.upstream}
    aria-label={`${ahead} to push, ${behind} to pull`}>{label}</small>;
}

function PrimaryLabel({ primary }: { primary: ReturnType<typeof sourceControlPrimary> }) {
  switch (primary.kind) {
    case "publish": return <><Icon name="upload" />Publish Branch</>;
    case "push": return <><Icon name="upload" />Push ↑{primary.ahead}</>;
    case "pull": return <><Icon name="download" />Pull ↓{primary.behind}</>;
    case "sync": return <><Icon name="restart" />Sync ↓{primary.behind} ↑{primary.ahead}</>;
    default: return <><Icon name="check" />Commit</>;
  }
}

function primaryTitle(primary: ReturnType<typeof sourceControlPrimary>, stagedCount: number): string {
  switch (primary.kind) {
    case "commit": return !stagedCount ? "Stage changes to commit them" : primary.enabled ? "Commit staged changes" : "Enter a commit message";
    case "publish": return "Publish this branch to its remote";
    case "push": return "Push commits to the upstream";
    case "pull": return "Fast-forward from the upstream";
    case "sync": return "Pull, then push";
    case "none": return "Nothing to commit or sync";
  }
}

function MenuItem({ icon, label, disabled = false, run }: { icon: IconName; label: string; disabled?: boolean; run(): void }) {
  return <button type="button" role="menuitem" disabled={disabled} onClick={run}><Icon name={icon} /><span>{label}</span></button>;
}

function ActionButton({ icon, label, disabled, run }: { icon: IconName; label: string; disabled: boolean; run(): void }) {
  return <button type="button" className="icon-button quiet" aria-label={label} title={label} disabled={disabled}
    onClick={(event) => { event.stopPropagation(); run(); }}><Icon name={icon} /></button>;
}

/// Section header actions, in VS Code's order: Discard, then Stage or Unstage.
function SectionActions({ section, disabled, actions, discard }: {
  section: SourceControlSection; disabled: boolean; actions: SourceControlActions; discard(entries: Entries): void;
}) {
  const entries = section.entries;
  switch (section.id) {
    case "conflicts": return <ActionButton icon="add" label="Stage all merge changes" disabled={disabled} run={() => void actions.stage(entries)} />;
    case "staged": return <ActionButton icon="minus" label="Unstage all changes" disabled={disabled} run={() => void actions.unstage(entries)} />;
    case "changes":
    case "untracked": return <>
      <ActionButton icon="undo" label={section.id === "changes" ? "Discard all changes" : "Delete all untracked files"} disabled={disabled} run={() => discard(entries)} />
      <ActionButton icon="add" label={section.id === "changes" ? "Stage all changes" : "Stage all untracked files"} disabled={disabled} run={() => void actions.stage(entries)} />
    </>;
  }
}

function RowActions({ section, entry, disabled, actions, discard }: {
  section: SourceControlSection["id"]; entry: TaskWorktreeChangeEntryDto; disabled: boolean; actions: SourceControlActions; discard(entries: Entries): void;
}) {
  const name = entry.display_path;
  if (section === "staged") return <ActionButton icon="minus" label={`Unstage ${name}`} disabled={disabled} run={() => void actions.unstage([entry])} />;
  if (section === "conflicts") return <ActionButton icon="add" label={`Mark ${name} as resolved`} disabled={disabled} run={() => void actions.stage([entry])} />;
  return <>
    <ActionButton icon="undo" label={section === "untracked" ? `Delete ${name}` : `Discard changes in ${name}`} disabled={disabled} run={() => discard([entry])} />
    <ActionButton icon="add" label={`Stage ${name}`} disabled={disabled} run={() => void actions.stage([entry])} />
  </>;
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
