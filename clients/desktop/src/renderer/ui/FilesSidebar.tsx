import { useRef, useSyncExternalStore } from "react";
import type { FileBrowser, FileBrowserSnapshot, FilesSubject } from "../file-browser.js";
import { FILES_ACTIVITY_BAR_WIDTH, FILES_SIDEBAR_MIN_WIDTH } from "../files-sidebar-preference.js";
import { FileTree } from "./FileTree.js";
import { Icon } from "./Icon.js";
import { useSidebarResizeDrag } from "./use-sidebar-resize-drag.js";
import "../../files.css";

/// Always visible at the window's right edge, like Orca's activity bar, so
/// the Files sidebar opens and closes from the same place.
export function FilesActivityBar({ open, toggle }: { open: boolean; toggle(): void }) {
  return <nav className="files-activity-bar" aria-label="Right sidebar">
    <button type="button" aria-label="Files sidebar" aria-pressed={open}
      className={open ? "selected" : undefined} title={open ? "Hide Files" : "Show Files"} onClick={toggle}
    ><Icon name="folder" /><span>Files</span></button>
  </nav>;
}

/// The right-hand Files sidebar: the root section row, a file name search,
/// then either the search results or the Explorer tree. Opening a file
/// opens it in an editor tab over the stage.
export function FilesSidebar({ subject, projectName, tasks, browser, snapshot, selectedPath, selectRoot, openFile, dismiss, close, unavailable }: {
  subject: FilesSubject | undefined;
  projectName: string | undefined;
  tasks: readonly { id: string; title: string }[];
  browser: FileBrowser;
  snapshot: FileBrowserSnapshot;
  selectedPath?: string | undefined;
  selectRoot(taskId: string | null): void;
  openFile(path: string): void;
  /// Escape outside a search hides the editor without closing its tabs.
  dismiss(): void;
  close(): void;
  unavailable: boolean;
}) {
  const search = useSyncExternalStore(browser.search.subscribe, browser.search.getSnapshot, browser.search.getSnapshot);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const searching = Boolean(subject && search.query.trim());
  const clearSearch = () => { browser.search.setQuery(""); searchInput.current?.focus(); };
  return <aside className="files-sidebar" aria-label="File browser" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (search.query) { event.preventDefault(); clearSearch(); } else dismiss();
  }}>
    <header className="files-sidebar-header">
      <h2>Explorer</h2>
      <button type="button" className="icon-button quiet" aria-label="Close Files sidebar" title="Close Files sidebar" onClick={close}><Icon name="close" /></button>
    </header>
    <div className="files-sidebar-section">
      <label className="files-root-picker"><select
        aria-label="File root"
        value={subject?.taskId ?? ""}
        disabled={!subject}
        onChange={(event) => selectRoot(event.target.value || null)}
      >
        <option value="">{projectName ?? "Project"}</option>
        {tasks.length ? <optgroup label="Task worktrees">{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</optgroup> : null}
      </select><Icon name="chevronDown" /></label>
      <button type="button" className="icon-button quiet" aria-label="Refresh files" title="Refresh files"
        aria-disabled={!subject || snapshot.refreshing}
        onClick={() => { if (subject && !snapshot.refreshing) void browser.refresh(); }}
      ><Icon name="restart" /></button>
      <button type="button" className="icon-button quiet" aria-label="Collapse all folders" title="Collapse all folders"
        aria-disabled={!subject || searching || snapshot.refreshing || !snapshot.expanded.size}
        onClick={() => { if (!searching) browser.collapseAll(); }}
      ><Icon name="collapseAll" /></button>
    </div>
    <div className="files-search-toolbar">
      <label className="rail-search"><Icon name="search" /><input
        ref={searchInput} type="text" aria-label="Search files" placeholder="Search files by name or path"
        maxLength={512} value={search.query} disabled={!subject}
        onChange={(event) => browser.search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && searching) {
            event.preventDefault(); searchResults.current?.querySelector<HTMLButtonElement>('[role="treeitem"]')?.focus();
          }
          if (event.key === "Enter" && searching && search.entries[0]) { event.preventDefault(); openFile(search.entries[0].path); }
        }}
      /></label>
      {search.query ? <button type="button" className="icon-button quiet" aria-label="Clear file search" title="Clear search (Esc)" onClick={clearSearch}><Icon name="close" /></button> : null}
    </div>
    <div className="files-sidebar-body">
      {!subject ? <p className="files-sidebar-empty">{unavailable ? "Connect to this computer to browse files." : "Select a Project to browse its files."}</p>
        : searching ? <div ref={searchResults}>
          <p className="files-search-status" role="status">{search.status === "searching" ? "Searching… · " : ""}{`${search.total} ${search.total === 1 ? "match" : "matches"}`}{search.total > search.entries.length ? ` · top ${search.entries.length} shown` : ""}</p>
          <p className="files-search-note">Hidden files included · .gitignore and .git skipped</p>
          {search.entries.length ? <FileTree snapshot={snapshot} selectedPath={selectedPath} toggle={() => {}} select={openFile} results={search.entries} />
            : search.status === "ready" ? <p className="files-sidebar-empty">No matching files.</p> : null}
          {search.status === "error" ? <p className="files-tree-message" role="alert">{search.error}</p> : null}
          {search.incomplete ? <p className="files-tree-message">The search stopped early or skipped unsupported names. Results may be incomplete.</p> : null}
          {search.unreadable ? <p className="files-tree-message">Some folders could not be read. Results may be incomplete.</p> : null}
        </div>
          : <FileTree snapshot={snapshot} selectedPath={selectedPath} toggle={(path) => browser.toggle(path)} select={openFile} />}
    </div>
  </aside>;
}

export function FilesSidebarResizeHandle({ width, maximum, resize, reset, draggingChanged }: {
  width: number;
  maximum: number;
  resize(width: number): void;
  reset(): void;
  draggingChanged(dragging: boolean): void;
}) {
  // The handle sits on the sidebar's left edge, so width grows as the pointer moves left.
  const { dragging, startDrag } = useSidebarResizeDrag((clientX) => resize(window.innerWidth - FILES_ACTIVITY_BAR_WIDTH - clientX), draggingChanged);
  return <div
    className={`sidebar-resize-handle files-sidebar-resize-handle${dragging ? " dragging" : ""}`}
    role="separator"
    aria-label="Resize Files sidebar"
    aria-orientation="vertical"
    aria-valuemin={FILES_SIDEBAR_MIN_WIDTH}
    aria-valuemax={maximum}
    aria-valuenow={width}
    tabIndex={0}
    title="Drag to resize Files sidebar · Double-click to reset"
    onDoubleClick={reset}
    onPointerDown={startDrag}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 40 : 10;
      const next = event.key === "ArrowLeft" ? width + step
        : event.key === "ArrowRight" ? width - step
          : event.key === "Home" ? FILES_SIDEBAR_MIN_WIDTH
            : event.key === "End" ? maximum
              : undefined;
      if (next === undefined) return;
      event.preventDefault();
      resize(next);
    }}
  />;
}
