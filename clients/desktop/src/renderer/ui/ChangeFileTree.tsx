import type {
  GitHostPullRequestChangeEntryDto,
  TaskBranchCommitChangeEntryDto,
  TaskWorktreeChangeEntryDto,
} from "@termloop/contract/current";
import {
  changeKindLabel,
  changeKindSymbol,
  changeTreeFolderId,
  type ChangeTreeNode,
} from "../change-tree.js";
import { Icon } from "./Icon.js";

export type ChangeEntry =
  | TaskWorktreeChangeEntryDto
  | TaskBranchCommitChangeEntryDto
  | GitHostPullRequestChangeEntryDto;

export type ChangeTreeSection = {
  id: string;
  title: string;
  nodes: readonly ChangeTreeNode<ChangeEntry>[];
  entryCount: number;
};

export function ChangeSection({ section, collapsedFolders, reviewedEntryIds, selectedId, select, toggleFolder, setReviewed }: {
  section: ChangeTreeSection;
  collapsedFolders: ReadonlySet<string>;
  reviewedEntryIds: ReadonlySet<string>;
  selectedId: string | undefined;
  select(id: string): void;
  toggleFolder(id: string): void;
  setReviewed(id: string, reviewed: boolean): void;
}) {
  if (section.entryCount === 0) return null;
  const collapsible = section.id === "reviewed";
  const sectionFolderId = changeTreeFolderId(section.id, "");
  const collapsed = collapsible && collapsedFolders.has(sectionFolderId);
  return (
    <section className="changes-file-section">
      <h2>{collapsible ? <button
        type="button"
        className="changes-file-section-toggle"
        aria-expanded={!collapsed}
        onClick={() => toggleFolder(sectionFolderId)}
      ><Icon name="chevronDown" className={collapsed ? "collapsed" : ""} /><b>{section.title}</b><span>{section.entryCount}</span></button> : <>{section.title}<span>{section.entryCount}</span></>}</h2>
      {!collapsed ? <div className="changes-file-tree" role="tree" aria-label={section.title}>
        <ChangeTreeNodes
          nodes={section.nodes}
          sectionId={section.id}
          collapsedFolders={collapsedFolders}
          reviewedEntryIds={reviewedEntryIds}
          depth={0}
          selectedId={selectedId}
          select={select}
          toggleFolder={toggleFolder}
          setReviewed={setReviewed}
        />
      </div> : null}
    </section>
  );
}

export function ChangeBadge({ entry }: { entry: ChangeEntry }) {
  const label = changeKindLabel(entry.kind);
  return <span className={`change-badge ${entry.kind}`} aria-label={label} title={label}>{changeKindSymbol(entry.kind)}</span>;
}

function ChangeTreeNodes({ nodes, sectionId, collapsedFolders, reviewedEntryIds, depth, selectedId, select, toggleFolder, setReviewed }: {
  nodes: readonly ChangeTreeNode<ChangeEntry>[];
  sectionId: string;
  collapsedFolders: ReadonlySet<string>;
  reviewedEntryIds: ReadonlySet<string>;
  depth: number;
  selectedId: string | undefined;
  select(id: string): void;
  toggleFolder(id: string): void;
  setReviewed(id: string, reviewed: boolean): void;
}) {
  return nodes.map((node) => {
    if (node.kind === "file") {
      const entry = node.entry;
      const reviewed = reviewedEntryIds.has(entry.entry_id);
      return (
        <div key={entry.entry_id} className={`changes-file-row${reviewed ? " reviewed" : ""}`} role="none">
          <button
            type="button"
            role="treeitem"
            className={`changes-file-entry status-${entry.kind}${entry.entry_id === selectedId ? " selected" : ""}`}
            style={{ paddingLeft: `${6 + depth * 13}px` }}
            aria-current={entry.entry_id === selectedId ? "true" : undefined}
            aria-level={depth + 1}
            data-change-entry-id={entry.entry_id}
            onClick={() => select(entry.entry_id)}
          >
            <ChangeBadge entry={entry} />
            <span>{node.name}</span>
            <small>{changeEntryDetail(entry)}</small>
          </button>
          <button
            type="button"
            className="changes-file-reviewed-toggle"
            aria-label={`Mark ${entry.display_path} as ${reviewed ? "unreviewed" : "reviewed"}`}
            aria-pressed={reviewed}
            title={reviewed ? "Move back to files to review" : "Mark file as reviewed"}
            onClick={() => setReviewed(entry.entry_id, !reviewed)}
          ><span aria-hidden="true">✓</span></button>
        </div>
      );
    }
    const folderId = changeTreeFolderId(sectionId, node.path);
    const collapsed = collapsedFolders.has(folderId);
    return (
      <div key={folderId} className="changes-folder-node" role="treeitem" aria-expanded={!collapsed} aria-level={depth + 1}>
        <button
          type="button"
          className="changes-folder-entry"
          style={{ paddingLeft: `${6 + depth * 13}px` }}
          onClick={() => toggleFolder(folderId)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" && !collapsed) {
              event.preventDefault();
              event.stopPropagation();
              toggleFolder(folderId);
            } else if (event.key === "ArrowRight" && collapsed) {
              event.preventDefault();
              event.stopPropagation();
              toggleFolder(folderId);
            }
          }}
        >
          <Icon name="chevronDown" className={collapsed ? "collapsed" : ""} />
          <Icon name="folder" />
          <span>{node.name}</span>
        </button>
        {!collapsed ? (
          <div role="group">
            <ChangeTreeNodes
              nodes={node.children}
              sectionId={sectionId}
              collapsedFolders={collapsedFolders}
              reviewedEntryIds={reviewedEntryIds}
              depth={depth + 1}
              selectedId={selectedId}
              select={select}
              toggleFolder={toggleFolder}
              setReviewed={setReviewed}
            />
          </div>
        ) : null}
      </div>
    );
  });
}

function changeEntryDetail(entry: ChangeEntry): string {
  const label = changeKindLabel(entry.kind);
  if (entry.original_display_path) return `${label} · from ${entry.original_display_path}`;
  if ("side" in entry) return `${label} · ${entry.side}`;
  return label;
}
