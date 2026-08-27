import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DirectoryBrowseResult } from "@termloop/contract/current";

import { Icon } from "../Icon.js";
import { worktreePathParent } from "../worktree-path-suggestion.js";
import { collapseFolderTrail, folderLeafName, folderTrail, type FolderTrailSegment } from "./folder-path.js";

export type FolderPickerActions = {
  defaultRoot(): Promise<{ path: string }>;
  browse(path: string): Promise<DirectoryBrowseResult>;
};

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/// The folder chooser rendered inside a Project dialog rather than stacked on
/// top of it: picking a folder is the main decision of that dialog, so it keeps
/// the name field and the confirm button visible the whole time.
///
/// Selection follows the highlight the way a native open panel does. One click
/// picks a folder, the chevron/double-click/Right enters it, and opening a
/// folder selects it too, so "the folder I am standing in" never needs a
/// separate button.
export function FolderPicker({ actions, sourceKey, initialPath, quickJumps = [], selected, onSelect, idPrefix, labelledBy, autoFocusFilter, pickLocalFolder }: {
  actions: FolderPickerActions;
  /// Reloads the picker when the connection it browses changes. Kept separate
  /// from `actions` so an inline actions object cannot retrigger the load on
  /// every parent render.
  sourceKey: string;
  initialPath?: string;
  quickJumps?: readonly FolderTrailSegment[];
  selected: string;
  onSelect(path: string): void;
  idPrefix: string;
  labelledBy?: string;
  autoFocusFilter?: boolean;
  /// The OS folder panel, present only where the browsed filesystem is this
  /// computer. Remote connections get the inline browser alone.
  pickLocalFolder?: ((defaultPath?: string) => Promise<string | null>) | undefined;
}) {
  const [listing, setListing] = useState<DirectoryBrowseResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [pathDraft, setPathDraft] = useState<string>();
  const requestRef = useRef(0);
  const rowsRef = useRef(new Map<string, HTMLDivElement>());
  const pendingFocusRef = useRef<string | undefined>(undefined);
  const actionsRef = useRef(actions);
  const selectRef = useRef(onSelect);
  const listingRef = useRef<DirectoryBrowseResult | undefined>(undefined);
  const pickLocalFolderRef = useRef(pickLocalFolder);
  actionsRef.current = actions;
  selectRef.current = onSelect;
  listingRef.current = listing;
  pickLocalFolderRef.current = pickLocalFolder;

  /// `prefer` highlights that child when the new listing contains it. `pin`
  /// keeps a path selected no matter what the listing turns out to hold, which
  /// is what a folder chosen in the OS panel needs: the choice is already made,
  /// and a listing failure must not quietly reassign it.
  const open = useCallback(async (path: string, options?: { prefer?: string; pin?: string }) => {
    const token = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    if (options?.pin) selectRef.current(options.pin);
    try {
      const result = await actionsRef.current.browse(path);
      if (requestRef.current !== token) return;
      setListing(result);
      setFilter("");
      setPathDraft(undefined);
      const preferred = options?.prefer;
      const child = preferred && result.entries.some((entry) => entry.path === preferred) ? preferred : undefined;
      if (!options?.pin) selectRef.current(child ?? result.path);
      pendingFocusRef.current = child;
    } catch (failure) {
      // The previous listing stays on screen so a denied or deleted folder
      // leaves the user somewhere they can still navigate from.
      if (requestRef.current === token) setError(failureMessage(failure));
    } finally {
      if (requestRef.current === token) setLoading(false);
    }
  }, []);

  /// Hands the choice to the OS panel and comes back with the folder revealed
  /// among its siblings, so the inline browser and the native panel leave the
  /// dialog in the same state.
  const pickNatively = useCallback(async () => {
    const picker = pickLocalFolderRef.current;
    if (!picker) return;
    const chosen = await picker(listingRef.current?.path);
    if (!chosen) return;
    const parent = worktreePathParent(chosen);
    await open(parent || chosen, parent ? { prefer: chosen, pin: chosen } : { pin: chosen });
  }, [open]);

  useEffect(() => {
    const token = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    setListing(undefined);
    setFilter("");
    setPathDraft(undefined);
    void (async () => {
      const requested = initialPath?.trim();
      try {
        const start = requested || (await actionsRef.current.defaultRoot()).path;
        try {
          const result = await actionsRef.current.browse(start);
          if (requestRef.current !== token) return;
          setListing(result);
        } catch (failure) {
          // A Project's recorded folder can be renamed or unmounted. Landing on
          // the default root keeps the dialog usable, and the recorded folder is
          // left selected so saving without a new pick changes nothing.
          if (!requested) throw failure;
          const fallback = await actionsRef.current.browse((await actionsRef.current.defaultRoot()).path);
          if (requestRef.current !== token) return;
          setListing(fallback);
          setError(`${requested} could not be opened (${failureMessage(failure)}). Pick a folder below.`);
        }
      } catch (failure) {
        if (requestRef.current === token) setError(failureMessage(failure));
      } finally {
        if (requestRef.current === token) setLoading(false);
      }
    })();
  }, [initialPath, sourceKey]);

  useLayoutEffect(() => {
    const path = pendingFocusRef.current;
    if (!path) return;
    const row = rowsRef.current.get(path);
    if (!row) return;
    pendingFocusRef.current = undefined;
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
  });

  const entries = listing?.entries ?? [];
  const query = filter.trim().toLowerCase();
  const matches = query ? entries.filter((entry) => entry.name.toLowerCase().includes(query)) : entries;
  const activeIndex = matches.findIndex((entry) => entry.path === selected);
  const listId = `${idPrefix}-folder-list`;

  const highlight = (delta: number) => {
    if (matches.length === 0) return;
    const next = activeIndex < 0
      ? (delta > 0 ? 0 : matches.length - 1)
      : Math.min(matches.length - 1, Math.max(0, activeIndex + delta));
    const target = matches[next];
    if (!target || target.path === selected) return;
    pendingFocusRef.current = target.path;
    onSelect(target.path);
  };

  const openSelectedChild = () => {
    const target = matches.find((entry) => entry.path === selected) ?? (matches.length === 1 ? matches[0] : undefined);
    if (target) void open(target.path);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); highlight(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); highlight(-1); return; }
    if (event.key === "Escape") {
      if (pathDraft !== undefined) { event.preventDefault(); event.stopPropagation(); setPathDraft(undefined); return; }
      if (filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); }
      return;
    }
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowRight" || event.key === "Enter") { event.preventDefault(); openSelectedChild(); return; }
    if (event.key === "ArrowLeft" || event.key === "Backspace") {
      if (!listing?.parentPath) return;
      event.preventDefault();
      void open(listing.parentPath, { prefer: listing.path });
    }
  };

  const crumbs = listing ? collapseFolderTrail(folderTrail(listing.path)) : [];

  return (
    <div className="folder-picker" role="group" aria-labelledby={labelledBy} onKeyDown={keyDown}>
      <div className="folder-picker-bar">
        <button
          type="button"
          className="folder-bar-button"
          aria-label="Parent folder"
          disabled={!listing?.parentPath}
          onClick={() => listing?.parentPath && void open(listing.parentPath, { prefer: listing.path })}
        ><Icon name="arrowLeft" /></button>
        {pathDraft === undefined ? (
          <div className="folder-crumbs" aria-label="Folder path">
            {crumbs.map((crumb, index) => {
              const divider = index > 0
                ? <span className="folder-crumb-divider" aria-hidden="true">›</span>
                : null;
              const key = crumb === "ellipsis" ? `gap-${index}` : crumb.path;
              const label = crumb === "ellipsis"
                ? <span className="folder-crumb-gap" aria-hidden="true">…</span>
                : index === crumbs.length - 1
                  ? <span className="folder-crumb current" title={crumb.path}>{crumb.name}</span>
                  : <button type="button" className="folder-crumb" title={crumb.path} onClick={() => void open(crumb.path)}>{crumb.name}</button>;
              return <Fragment key={key}>{divider}{label}</Fragment>;
            })}
          </div>
        ) : (
          <input
            className="folder-path-input"
            aria-label="Folder path"
            autoFocus
            spellCheck={false}
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.stopPropagation();
              if (pathDraft.trim()) void open(pathDraft.trim());
            }}
          />
        )}
        <div className="folder-bar-actions">
          <button
            type="button"
            className="folder-bar-button"
            aria-label={pathDraft === undefined ? "Type a folder path" : "Show the folder path as steps"}
            aria-pressed={pathDraft !== undefined}
            onClick={() => setPathDraft(pathDraft === undefined ? listing?.path ?? "" : undefined)}
          ><Icon name="edit" /></button>
          {pickLocalFolder ? (
            <button type="button" className="folder-browse-button" onClick={() => void pickNatively()}>Browse…</button>
          ) : null}
        </div>
      </div>

      {quickJumps.length > 0 ? (
        <div className="folder-jumps">
          <span className="folder-jumps-label">Jump to</span>
          {quickJumps.map((jump) => (
            <button key={jump.path} type="button" title={jump.path} onClick={() => void open(jump.path)}>{jump.name}</button>
          ))}
        </div>
      ) : null}

      <div className="folder-filter">
        <Icon name="search" />
        <input
          aria-label="Filter folders"
          autoFocus={autoFocusFilter}
          aria-controls={listId}
          placeholder="Filter folders"
          spellCheck={false}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openSelectedChild(); } }}
        />
        <span className="folder-filter-count">{loading && !listing ? "…" : query ? `${matches.length}/${entries.length}` : `${entries.length}`}</span>
      </div>

      {error ? <p className="folder-picker-error" role="alert">{error}</p> : null}

      <div id={listId} className="folder-picker-list" role="listbox" aria-label="Folders" aria-busy={loading} data-loading={loading ? "true" : undefined}>
        {loading && !listing ? <p className="folder-picker-note">Loading folders…</p> : null}
        {listing && matches.length === 0
          ? <p className="folder-picker-note">{query ? `No folder here matches “${filter.trim()}”.` : "This folder has no subfolders. Use it, or go up a level."}</p>
          : null}
        {matches.map((entry, index) => {
          const active = entry.path === selected;
          return (
            <div
              key={entry.path}
              ref={(node) => { if (node) rowsRef.current.set(entry.path, node); else rowsRef.current.delete(entry.path); }}
              className={active ? "folder-row selected" : "folder-row"}
              role="option"
              aria-selected={active}
              tabIndex={index === (activeIndex < 0 ? 0 : activeIndex) ? 0 : -1}
              onClick={() => onSelect(entry.path)}
              onDoubleClick={() => void open(entry.path)}
            >
              <Icon name="folder" />
              <span className="folder-row-name">{entry.name}</span>
              {entry.kind === "symlinkDirectory" ? <span className="folder-row-tag">link</span> : null}
              <button
                type="button"
                className="folder-row-open"
                tabIndex={-1}
                aria-label={`Open ${entry.name}`}
                onClick={(event) => { event.stopPropagation(); void open(entry.path); }}
              ><Icon name="arrowRight" /></button>
            </div>
          );
        })}
      </div>

      <div className="folder-picker-selection">
        <span className="folder-selection-icon"><Icon name="folder" /></span>
        <span className="folder-selection-copy">
          <strong>{selected ? folderLeafName(selected) : "No folder chosen yet"}</strong>
          <small title={selected}>{selected || "Click a folder to choose it. Double-click, or press →, to look inside."}</small>
        </span>
        {selected && listing && selected === listing.path ? <span className="folder-selection-tag">open folder</span> : null}
      </div>
    </div>
  );
}
