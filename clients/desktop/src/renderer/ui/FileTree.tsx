import { useRef, useState, type KeyboardEvent } from "react";
import type { WorkspaceFileEntryDto } from "@termloop/contract/current";
import { fileTreeRows, type FileBrowserSnapshot, type FileTreeRow } from "../file-browser.js";
import { Icon } from "./Icon.js";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.js";

export function FileTree({ snapshot, toggle, select, results }: {
  snapshot: FileBrowserSnapshot;
  toggle(path: string): void;
  select(path: string): void;
  results?: readonly WorkspaceFileEntryDto[];
}) {
  const [focused, setFocused] = useState<string>();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const rows: FileTreeRow[] = results ? results.map((entry) => ({ kind: "entry", entry, depth: 0 })) : fileTreeRows(snapshot);
  const paths = rows.flatMap((row) => row.kind === "entry" ? [row.entry.path] : []);
  const tabStop = focused && paths.includes(focused) ? focused : paths[0];
  const focus = (path: string | undefined) => { if (path !== undefined) buttons.current.get(path)?.focus(); };
  const keyDown = (event: KeyboardEvent, path: string, folder: boolean) => {
    const index = paths.indexOf(path);
    switch (event.key) {
      case "ArrowDown": focus(paths[index + 1]); break;
      case "ArrowUp": focus(paths[index - 1]); break;
      case "Home": focus(paths[0]); break;
      case "End": focus(paths.at(-1)); break;
      case "ArrowRight":
        if (folder) {
          if (!snapshot.expanded.has(path)) toggle(path);
          else if (paths[index + 1]?.startsWith(`${path}/`)) focus(paths[index + 1]);
        }
        break;
      case "ArrowLeft":
        if (folder && snapshot.expanded.has(path)) toggle(path);
        else focus(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined);
        break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  return <div role="tree" aria-label={results ? "File search results" : "Workspace files"} className={`files-tree${results ? " files-search-tree" : ""}`}>
    {rows.map((row) => {
      if (row.kind === "message") return <p key={`message:${row.path}`} className={`files-tree-message${row.error ? " error" : ""}`} role={row.error ? "alert" : undefined} style={{ paddingLeft: 12 + row.depth * 14 }}>{row.message}</p>;
      const { entry, depth } = row;
      const folder = entry.kind === "directory";
      const expanded = snapshot.expanded.has(entry.path);
      const selected = snapshot.preview.status !== "empty" && snapshot.preview.path === entry.path;
      return <button
        key={entry.path}
        ref={(button) => { if (button) buttons.current.set(entry.path, button); else buttons.current.delete(entry.path); }}
        type="button" role="treeitem" aria-level={depth + 1}
        aria-expanded={folder ? expanded : undefined} aria-selected={selected}
        disabled={folder && snapshot.refreshing}
        tabIndex={tabStop === entry.path ? 0 : -1}
        className={`files-tree-entry${selected ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }} title={entry.path}
        onFocus={() => setFocused(entry.path)}
        onKeyDown={(event) => keyDown(event, entry.path, folder)}
        onClick={() => folder ? toggle(entry.path) : select(entry.path)}
      >
        <span className={`files-tree-chevron${expanded ? " expanded" : ""}`}>{folder ? <Icon name="chevronDown" /> : null}</span>
        <WorkspaceFileIcon entry={entry} />
        {results ? <span className="files-search-label"><span className="files-tree-name">{entry.name}</span><small>{entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "."}</small></span>
          : <span className="files-tree-name">{entry.name}</span>}
        {entry.kind === "symlink" ? <small>link</small> : null}
      </button>;
    })}
  </div>;
}
