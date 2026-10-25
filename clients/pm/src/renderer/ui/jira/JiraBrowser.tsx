// The stage's Jira issue browser, ported from Orca's task-page Jira view:
// filters, a header with the sprint toggle and List | Board, then the issues
// or a not-connected, loading, error, or empty state. Read-only toward Jira.
import { useMemo } from "react";
import { Icon } from "../icons.js";
import { JiraBoard } from "./JiraBoard.js";
import { JiraFilters, type JiraFiltersProps } from "./JiraFilters.js";
import { JiraIssueList, type JiraIssueActions } from "./JiraIssueList.js";
import {
  boardLanes,
  groupIssuesByStatus,
  statusChips,
  statusRanks,
  type JiraBrowserView,
  type JiraViewMode,
} from "./jira-view-state.js";

export type JiraBrowserActions = Omit<JiraFiltersProps, "query" | "effectiveJql" | "loading" | "projects" | "chips" | "favourites" | "savedFilters" | "activeFilterId">
  & Omit<JiraIssueActions, "adding">
  & {
    onMode(mode: JiraViewMode): void;
    onCurrentSprint(on: boolean): void;
    onOpenSettings(): void;
  };

/** `checking` while the project's sources are read; `notConnected` when it has no Jira source. */
export type JiraConnection = "checking" | "notConnected" | "connected";

export function JiraBrowser(props: { connection: JiraConnection; view: JiraBrowserView; now: number; actions: JiraBrowserActions }) {
  const { view, actions } = props;
  const ranks = useMemo(() => statusRanks(view.statuses, view.columns), [view.statuses, view.columns]);
  const issues = view.result?.issues;
  const sections = useMemo(() => (issues ? groupIssuesByStatus(issues, ranks) : []), [issues, ranks]);
  const lanes = useMemo(() => (issues && view.mode === "board" ? boardLanes(issues, view.statuses, view.columns) : []), [issues, view.mode, view.statuses, view.columns]);
  const chips = useMemo(() => statusChips(view.statusCatalog, view.query.statuses, ranks), [view.statusCatalog, view.query.statuses, ranks]);

  if (props.connection === "checking") return <section className="pane jira-browser" aria-label="Jira issues"><LoadingRows /></section>;
  if (props.connection === "notConnected" || view.failure?.notConnected) {
    return (
      <section className="pane jira-browser" aria-label="Jira issues">
        <div className="body empty-state">
          <p className="lead">{view.failure?.notConnected ? view.failure.message : "Jira is not connected for this project."}</p>
          <p className="hint">Connect a Jira site and API token in Settings to browse its issues here.</p>
          <button type="button" className="btn pri" onClick={actions.onOpenSettings}>Open Settings</button>
        </div>
      </section>
    );
  }

  const issueActions: JiraIssueActions = { ...actions, adding: view.adding };
  const custom = view.query.preset === "custom";
  return (
    <section className="pane jira-browser" aria-label="Jira issues">
      <JiraFilters
        {...actions}
        query={view.query}
        effectiveJql={view.result?.jql}
        loading={view.loading}
        projects={view.projects}
        chips={chips}
        favourites={view.favourites}
        savedFilters={view.savedFilters}
        activeFilterId={view.activeFilterId}
      />
      <div className="jira-head">
        <span className="sec-label">Jira issues</span>
        <span className="sp" />
        <label className="jira-toggle" title={custom ? "Current sprint applies to preset views" : undefined}>
          <input type="checkbox" checked={view.query.currentSprint} disabled={custom} onChange={(event) => actions.onCurrentSprint(event.target.checked)} />
          Current sprint
        </label>
        <div className="seg" role="group" aria-label="Jira view">
          {(["list", "board"] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={view.mode === mode} className={view.mode === mode ? "on" : undefined} onClick={() => actions.onMode(mode)}>
              <Icon name={mode} />{mode === "list" ? "List" : "Board"}
            </button>
          ))}
        </div>
        {issues && (
          <span className="meta" title={view.result?.truncated ? "Jira returned more issues than one page; narrow the search to see the rest." : undefined}>
            {issues.length} shown{view.result?.truncated ? " · truncated" : ""}
          </span>
        )}
      </div>
      <div className={`jira-content ${view.loading && issues ? "stale" : ""}`}>
        {view.failure ? (
          <div className="jira-state" role="alert">
            <p className="error">{view.failure.message}</p>
            <button type="button" className="btn sm" onClick={actions.onRefresh}>Retry</button>
          </div>
        ) : !issues ? (
          view.loading ? <LoadingRows /> : null
        ) : issues.length === 0 ? (
          <div className="jira-state"><p className="hint">No issues match this view.</p></div>
        ) : view.mode === "board" ? (
          <JiraBoard lanes={lanes} actions={issueActions} />
        ) : (
          <JiraIssueList sections={sections} now={props.now} actions={issueActions} />
        )}
      </div>
    </section>
  );
}

function LoadingRows() {
  return (
    <div className="jira-skeleton" aria-busy="true" aria-label="Loading Jira issues">
      {Array.from({ length: 6 }, (_, index) => <div key={index} className="jira-skeleton-row" />)}
    </div>
  );
}
