import { useRef, useSyncExternalStore } from "react";
import type { FileBrowser, FileBrowserSnapshot, FilesSubject } from "../file-browser.js";
import { FileTree } from "./FileTree.js";
import { Icon } from "./Icon.js";
import "../../files.css";

export function FilesRail({ subject, projectName, tasks, browser, snapshot, selectRoot, openFile, unavailable }: {
  subject: FilesSubject | undefined;
  projectName: string | undefined;
  tasks: readonly { id: string; title: string }[];
  browser: FileBrowser;
  snapshot: FileBrowserSnapshot;
  selectRoot(taskId: string | null): void;
  openFile(path: string): void;
  unavailable: boolean;
}) {
  const search = useSyncExternalStore(browser.search.subscribe, browser.search.getSnapshot, browser.search.getSnapshot);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const searching = Boolean(search.query.trim());
  const clearSearch = () => { browser.search.setQuery(""); searchInput.current?.focus(); };
  return <nav className="settings-rail files-rail" aria-label="File browser" onKeyDown={(event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (search.query) { event.preventDefault(); clearSearch(); } else browser.clearPreview();
    }
  }}>
    <div className="settings-rail-toolbar">
      <label className="files-root-picker"><Icon name="folder" /><select
        aria-label="File root"
        value={subject?.taskId ?? ""}
        disabled={!subject}
        onChange={(event) => selectRoot(event.target.value || null)}
      >
        <option value="">{projectName ?? "Project"}</option>
        {tasks.length ? <optgroup label="Task worktrees">{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</optgroup> : null}
      </select></label>
      <button type="button" className="icon-button quiet" aria-label="Refresh files" title="Refresh files"
        aria-disabled={!subject || snapshot.refreshing}
        onClick={() => { if (subject && !snapshot.refreshing) void browser.refresh(); }}
      ><Icon name="restart" /></button>
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
    <p className="settings-rail-note">Hidden and ignored files included · .git hidden</p>
    {subject && searching ? <div ref={searchResults}>
      <p className="files-search-status" role="status">{search.status === "searching" ? `Searching… · ${search.directories} folders · ` : ""}{`${search.total} ${search.total === 1 ? "match" : "matches"}`}</p>
      {search.pages > 1 ? <div className="files-search-pages">
        <button type="button" className="secondary-button" aria-label="Previous file results" disabled={search.page === 0} onClick={() => browser.search.setPage(search.page - 1)}>Previous</button>
        <span>Page {search.page + 1} of {search.pages}</span>
        <button type="button" className="secondary-button" aria-label="Next file results" disabled={search.page + 1 >= search.pages} onClick={() => browser.search.setPage(search.page + 1)}>Next</button>
      </div> : null}
      {search.entries.length ? <FileTree snapshot={snapshot} toggle={() => {}} select={openFile} results={search.entries} />
        : search.status === "ready" ? <p className="settings-rail-empty">No matching files.</p> : null}
      {search.incomplete ? <p className="files-tree-message">Some file names could not be listed. Results may be incomplete.</p> : null}
      {search.unreadable ? <p className="files-tree-message">Some folders could not be read. Results may be incomplete.</p> : null}
    </div> : subject ? <FileTree snapshot={snapshot} toggle={(path) => browser.toggle(path)} select={openFile} />
      : <p className="settings-rail-empty">{unavailable ? "Connect to this computer to browse files." : "Select a Project to browse its files."}</p>}
  </nav>;
}
