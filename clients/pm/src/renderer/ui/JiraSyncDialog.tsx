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
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="Write to Jira">
        <div className="modal-head">
          <b>Write to Jira</b>{diff && <span className="k">{diff.issueKey}</span>}<span className="sp" />
          <button type="button" className="icb" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        {dialog.loading && <p className="hint">{diff ? "Writing…" : "Reading Jira…"}</p>}
        {dialog.error && <p className="error">{dialog.error}</p>}
        {dialog.staleNotice && (
          <p className="warning" role="status">Jira changed since this diff was read. Review the updated changes below before applying.</p>
        )}
        {result?.kind === "applied" && <p className="success">Written to Jira: {result.changes.length} change(s).</p>}
        {result?.kind === "failed" && (
          <p className="error">
            {FAILURE_LABEL[result.reason]}{result.applied.length > 0 ? ` ${result.applied.length} change(s) were written before the failure.` : ""}
          </p>
        )}
        {diff && !result && (
          diff.changes.length === 0 ? <p className="hint">Jira already matches this ticket.</p> : (
            <table className="diff-table">
              <thead><tr><th>Field</th><th>In Jira</th><th>Will become</th></tr></thead>
              <tbody>{diff.changes.map((change, index) => <ChangeRow key={index} change={change} />)}</tbody>
            </table>
          )
        )}
        {diff?.statusUnreachable && !result && <p className="hint">The ticket's status has no Jira transition from the current state; status is left unchanged.</p>}
        <div className="card-foot">
          <button type="button" className="btn sm ghost" onClick={props.onClose}>{result ? "Close" : "Cancel"}</button>
          {!result && (
            <button type="button" className="btn sm pri" disabled={!diff || dialog.loading || diff.changes.length === 0} onClick={props.onApply}>Apply</button>
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
      return <tr><td>Description</td><td className="pre">{change.jira ?? "—"}</td><td className="pre">{change.ticket}</td></tr>;
    case "status":
      return <tr><td>Status</td><td>{change.jira ?? "—"}</td><td>{change.toStatus} <span className="muted">via “{change.transitionName}”</span></td></tr>;
    case "sprint":
      return <tr><td>Sprint</td><td>{change.jiraSprintId ?? "—"}</td><td>{change.ticketSprintId ?? "Backlog"}</td></tr>;
  }
}
