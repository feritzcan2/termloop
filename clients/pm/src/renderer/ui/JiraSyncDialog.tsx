import type { PmJiraChange, PmJiraFailure } from "@termloop/pm-contract/pm";
import type { JiraDialogView } from "./types.js";

export type JiraSyncDialogProps = {
  dialog: JiraDialogView;
  onApply(): void;
  onClose(): void;
};

const FAILURE_LABEL: Record<PmJiraFailure, string> = {
  notConfigured: "Jira is not configured for this project.",
  credentialMissing: "The Jira API token is missing; add it in Settings.",
  invalidSite: "The Jira site URL is invalid.",
  invalidRequest: "Jira refused the request.",
  unauthorized: "Jira rejected the credentials.",
  forbidden: "The Jira account may not edit this issue.",
  notFound: "The Jira issue was not found.",
  rejected: "Jira rejected the change.",
  rateLimited: "Jira is rate limiting; try again shortly.",
  unavailable: "Jira is unreachable.",
  responseTooLarge: "Jira returned too much data.",
  malformedResponse: "Jira returned an unexpected response.",
};

/**
 * Shows exactly what would be written to Jira. Only Apply writes, and it
 * sends the token of the diff on screen; a stale token yields the new diff.
 */
export function JiraSyncDialog(props: JiraSyncDialogProps) {
  const { dialog } = props;
  const diff = dialog.diff;
  const result = dialog.result;
  return (
    <div className="pm-modal-backdrop">
      <div className="pm-modal" role="dialog" aria-label="Write to Jira">
        <div className="pm-card-head">
          <h3>Write to Jira{diff ? ` · ${diff.issueKey}` : ""}</h3>
          <button type="button" className="pm-icon-button" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        {dialog.loading && <p className="pm-hint">{diff ? "Writing…" : "Reading Jira…"}</p>}
        {dialog.error && <p className="pm-error">{dialog.error}</p>}
        {dialog.staleNotice && (
          <p className="pm-warning" role="status">Jira changed since this diff was read. Review the updated changes below before applying.</p>
        )}
        {result?.kind === "applied" && <p className="pm-success">Written to Jira: {result.changes.length} change(s).</p>}
        {result?.kind === "failed" && (
          <p className="pm-error">
            {FAILURE_LABEL[result.reason]}{result.applied.length > 0 ? ` ${result.applied.length} change(s) were written before the failure.` : ""}
          </p>
        )}
        {diff && !result && (
          diff.changes.length === 0 ? <p className="pm-hint">Jira already matches this ticket.</p> : (
            <table className="pm-table pm-jira-diff">
              <thead><tr><th>Field</th><th>In Jira</th><th>Will become</th></tr></thead>
              <tbody>{diff.changes.map((change, index) => <ChangeRow key={index} change={change} />)}</tbody>
            </table>
          )
        )}
        {diff?.statusUnreachable && !result && <p className="pm-hint">The ticket's status has no Jira transition from the current state; status is left unchanged.</p>}
        <div className="pm-card-foot">
          <button type="button" className="pm-button ghost" onClick={props.onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && (
            <button type="button" className="pm-button primary" disabled={!diff || dialog.loading || diff.changes.length === 0} onClick={props.onApply}>Apply</button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChangeRow({ change }: { change: PmJiraChange }) {
  switch (change.field) {
    case "summary":
      return <tr><td>Summary</td><td>{change.jira}</td><td>{change.ticket}</td></tr>;
    case "description":
      return <tr><td>Description</td><td className="pm-pre">{change.jira ?? "—"}</td><td className="pm-pre">{change.ticket}</td></tr>;
    case "status":
      return <tr><td>Status</td><td>{change.jira ?? "—"}</td><td>{change.toStatus} <span className="pm-muted">via “{change.transitionName}”</span></td></tr>;
    case "sprint":
      return <tr><td>Sprint</td><td>{change.jiraSprintId ?? "—"}</td><td>{change.ticketSprintId ?? "Backlog"}</td></tr>;
  }
}
