// The Jira browser's filter block (Orca's task-page Jira filters): project
// picker, presets, Jira favourites, saved filters, new issue, refresh; status
// chips; the effective JQL with "Edit as JQL"; and the search input.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PmJiraFavouriteFilter, PmJiraProject } from "@termloop/pm-contract/pm";
import {
  MAX_SAVED_FILTERS,
  MAX_SAVED_FILTER_NAME_LENGTH,
  jqlWithinLimit,
  type JiraSavedFilter,
} from "../../state/jira-browser-preference.js";
import { Icon } from "../icons.js";
import { JIRA_PRESETS, MAX_SEARCH_TEXT_CHARS, looksLikeJql, type JiraPreset, type JiraQuery, type JiraStatusItem } from "./jira-view-state.js";

export const SEARCH_DEBOUNCE_MS = 300;

export type JiraFiltersProps = {
  query: JiraQuery;
  /** The JQL the last search ran, as Jira received it. */
  effectiveJql: string | undefined;
  loading: boolean;
  projects: PmJiraProject[];
  chips: JiraStatusItem[];
  favourites: PmJiraFavouriteFilter[];
  savedFilters: JiraSavedFilter[];
  activeFilterId: string | undefined;
  /** Opens Jira's create-issue page; absent when the site is unknown. */
  onNewIssue: (() => void) | undefined;
  onPreset(preset: JiraPreset): void;
  onProjectKey(key: string | null): void;
  onToggleStatus(name: string): void;
  onClearStatuses(): void;
  onRunJql(jql: string): void;
  onText(text: string): void;
  onApplyFilter(filter: { id: string; jql: string }): void;
  /** Returns why the save was refused. */
  onSaveFilter(filter: { id?: string; name: string; jql: string }): string | undefined;
  onDeleteFilter(id: string): void;
  onRefresh(): void;
};

export function JiraFilters(props: JiraFiltersProps) {
  const { query } = props;
  const custom = query.preset === "custom";
  const currentJql = custom ? query.jql : props.effectiveJql ?? "";
  return (
    <div className="jira-filters">
      <div className="jira-row">
        <select
          aria-label="Jira project"
          className="jira-project"
          value={query.jiraProjectKey ?? ""}
          disabled={custom}
          title={custom ? "Custom JQL picks its own projects" : undefined}
          onChange={(event) => props.onProjectKey(event.target.value || null)}
        >
          <option value="">All Jira projects</option>
          {props.projects.map((project) => <option key={project.key} value={project.key}>{project.name} ({project.key})</option>)}
          {query.jiraProjectKey && !props.projects.some((project) => project.key === query.jiraProjectKey) && (
            <option value={query.jiraProjectKey}>{query.jiraProjectKey}</option>
          )}
        </select>
        <div className="seg" role="group" aria-label="Jira presets">
          {JIRA_PRESETS.map(({ preset, label }) => {
            const pressed = !custom && !query.text && query.preset === preset;
            return (
              <button key={preset} type="button" aria-pressed={pressed} className={pressed ? "on" : undefined} onClick={() => props.onPreset(preset)}>
                {label}
              </button>
            );
          })}
        </div>
        <span className="sp" />
        <FavouritesMenu favourites={props.favourites} activeId={props.activeFilterId} onApply={props.onApplyFilter} />
        <SavedFiltersMenu
          filters={props.savedFilters}
          activeId={props.activeFilterId}
          currentJql={currentJql}
          onApply={props.onApplyFilter}
          onSave={props.onSaveFilter}
          onDelete={props.onDeleteFilter}
        />
        {props.onNewIssue && (
          <button type="button" className="icb bordered" aria-label="New Jira issue" title="New Jira issue (opens Jira)" onClick={props.onNewIssue}>
            <Icon name="plus" />
          </button>
        )}
        <button type="button" className="icb bordered" aria-label="Refresh Jira issues" title="Refresh Jira issues" disabled={props.loading} onClick={props.onRefresh}>
          <Icon name="refresh" />
        </button>
      </div>
      <StatusChips {...props} custom={custom} />
      <JqlRow jql={props.effectiveJql} onRun={props.onRunJql} />
      <SearchInput text={query.text} onText={props.onText} onRunJql={props.onRunJql} />
    </div>
  );
}

function StatusChips(props: JiraFiltersProps & { custom: boolean }) {
  const selected = props.query.statuses;
  if (props.custom) return selected.length > 0 ? <p className="hint">Status filters apply to preset views. Pick a preset to use them.</p> : null;
  if (props.chips.length === 0) return null;
  return (
    <div className="jira-row wrap">
      <div className="jira-chips" role="group" aria-label="Filter Jira issues by status">
        {props.chips.map((status) => {
          const on = selected.includes(status.name);
          return (
            <button key={status.name} type="button" aria-pressed={on} className={`jira-chip cat-${status.category} ${on ? "on" : ""}`} onClick={() => props.onToggleStatus(status.name)}>
              {status.name}
            </button>
          );
        })}
      </div>
      {selected.length > 0 && <button type="button" className="btn sm ghost" onClick={props.onClearStatuses}>Clear statuses</button>}
      {selected.length > 0 && <p className="hint jira-hint">Statuses come from loaded issues. Clear statuses to discover others in this view.</p>}
    </div>
  );
}

/** The effective JQL, read-only until "Edit as JQL"; Enter runs the edit as custom JQL. */
function JqlRow(props: { jql: string | undefined; onRun(jql: string): void }) {
  const [draft, setDraft] = useState<string>();
  if (props.jql === undefined && draft === undefined) return null;
  const editing = draft !== undefined;
  const run = () => {
    if (!draft?.trim()) return;
    props.onRun(draft);
    setDraft(undefined);
  };
  return (
    <div className="jira-row">
      <input
        aria-label="Effective JQL"
        className="jira-jql"
        readOnly={!editing}
        value={editing ? draft : props.jql ?? ""}
        maxLength={8192}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (!editing) return;
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); run(); }
          if (event.key === "Escape") setDraft(undefined);
        }}
      />
      {editing ? (
        <>
          <button type="button" className="btn sm pri" disabled={!draft.trim()} onClick={run}>Run</button>
          <button type="button" className="btn sm ghost" onClick={() => setDraft(undefined)}>Cancel</button>
        </>
      ) : (
        <button type="button" className="btn sm" onClick={() => setDraft(props.jql ?? "")}>Edit as JQL</button>
      )}
    </div>
  );
}

/** Text searches apply after a pause; input written as JQL runs as JQL on Enter. */
function SearchInput(props: { text: string; onText(text: string): void; onRunJql(jql: string): void }) {
  const [value, setValue] = useState(props.text);
  const { onText } = props;
  useEffect(() => setValue(props.text), [props.text]);
  useEffect(() => {
    if (looksLikeJql(value)) return;
    const timer = setTimeout(() => onText(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, onText]);
  const jql = looksLikeJql(value);
  return (
    <div className="jira-search">
      <Icon name="search" />
      <input
        aria-label="Search Jira issues"
        value={value}
        maxLength={jql ? 8192 : MAX_SEARCH_TEXT_CHARS}
        placeholder="Search issues or enter JQL, e.g. project = ABC"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (jql) { setValue(""); props.onRunJql(value); } else onText(value);
        }}
      />
      {jql && <span className="jira-search-tag">JQL · Enter to run</span>}
      {value && <button type="button" className="icb" aria-label="Clear search" onClick={() => { setValue(""); onText(""); }}><Icon name="close" /></button>}
    </div>
  );
}

/** A trigger button and a menu that closes on choice, Escape, or a click outside. */
function Menu(props: { label: string; icon?: "jira" | "list"; children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  return (
    <div className="jira-menu" ref={root} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
      <button type="button" className="btn sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {props.icon && <Icon name={props.icon} />}{props.label}<Icon name="down" />
      </button>
      {open && <div role="menu" className="pm-menu jira-menu-list" aria-label={props.label}>{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

function FavouritesMenu(props: { favourites: PmJiraFavouriteFilter[]; activeId: string | undefined; onApply(filter: PmJiraFavouriteFilter): void }) {
  return (
    <Menu label="Jira favourites" icon="jira">
      {(close) => props.favourites.length === 0
        ? <p className="jira-menu-empty">No favourite filters in Jira.</p>
        : props.favourites.map((filter) => (
          <button key={filter.id} type="button" role="menuitem" aria-current={filter.id === props.activeId} title={filter.jql} onClick={() => { close(); props.onApply(filter); }}>
            {filter.name}
          </button>
        ))}
    </Menu>
  );
}

type FilterDraft = { id?: string; name: string; jql: string };

function SavedFiltersMenu(props: {
  filters: JiraSavedFilter[];
  activeId: string | undefined;
  currentJql: string;
  onApply(filter: JiraSavedFilter): void;
  onSave(filter: FilterDraft): string | undefined;
  onDelete(id: string): void;
}) {
  const [draft, setDraft] = useState<FilterDraft>();
  const full = props.filters.length >= MAX_SAVED_FILTERS;
  return (
    <>
      <Menu label="Saved filters" icon="list">
        {(close) => (
          <>
            {props.filters.length === 0 && <p className="jira-menu-empty">No saved filters yet.</p>}
            {props.filters.map((filter) => (
              <div key={filter.id} className="jira-menu-item">
                <button type="button" role="menuitem" aria-current={filter.id === props.activeId} title={filter.jql} onClick={() => { close(); props.onApply(filter); }}>
                  {filter.name}
                </button>
                <button type="button" className="icb" aria-label={`Edit ${filter.name}`} onClick={() => { close(); setDraft({ ...filter }); }}><Icon name="more" /></button>
                <button type="button" className="icb" aria-label={`Delete ${filter.name}`} onClick={() => props.onDelete(filter.id)}><Icon name="close" /></button>
              </div>
            ))}
            {full && <p className="jira-menu-empty">You can save up to {MAX_SAVED_FILTERS} filters.</p>}
            <button type="button" role="menuitem" className="jira-menu-foot" disabled={full || !props.currentJql.trim()} onClick={() => { close(); setDraft({ name: "", jql: props.currentJql.trim() }); }}>
              <Icon name="plus" /> Save current filter
            </button>
          </>
        )}
      </Menu>
      {draft && <SavedFilterDialog draft={draft} onSave={props.onSave} onClose={() => setDraft(undefined)} />}
    </>
  );
}

function SavedFilterDialog(props: { draft: FilterDraft; onSave(filter: FilterDraft): string | undefined; onClose(): void }) {
  const [name, setName] = useState(props.draft.name);
  const [jql, setJql] = useState(props.draft.jql);
  const [error, setError] = useState<string>();
  const valid = name.trim() !== "" && jql.trim() !== "" && jqlWithinLimit(jql);
  const save = () => {
    const refusal = props.onSave({ ...(props.draft.id ? { id: props.draft.id } : {}), name, jql });
    if (refusal) setError(refusal);
    else props.onClose();
  };
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label={props.draft.id ? "Edit saved filter" : "Save filter"} onKeyDown={(event) => { if (event.key === "Escape") props.onClose(); }}>
        <div className="modal-head">
          <b>{props.draft.id ? "Edit saved filter" : "Save filter"}</b><span className="sp" />
          <button type="button" className="icb" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        <label className="jira-field">
          <span className="sec-label">Name</span>
          <input aria-label="Filter name" value={name} maxLength={MAX_SAVED_FILTER_NAME_LENGTH} autoFocus onChange={(event) => { setName(event.target.value); setError(undefined); }} />
        </label>
        <label className="jira-field">
          <span className="sec-label">JQL</span>
          <textarea aria-label="Filter JQL" rows={4} value={jql} onChange={(event) => { setJql(event.target.value); setError(undefined); }} />
        </label>
        {!jqlWithinLimit(jql) && <p className="error">JQL must be under 8 KiB.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="card-foot">
          <button type="button" className="btn sm ghost" onClick={props.onClose}>Cancel</button>
          <button type="button" className="btn sm pri" disabled={!valid} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
