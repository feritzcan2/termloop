import { useEffect, useState } from "react";
import type { JiraIssueTextDto, JiraWriteFailureReason, ProjectManagerJiraIssueResult } from "@termloop/contract/current";

import { Icon } from "./Icon.js";
import { jiraWikiToMarkdown, type TicketDraft } from "./project-manager-ticket.js";
import { errorText } from "./ProjectManagerWorkspace.js";

const FAILURES: Record<JiraWriteFailureReason, string> = {
  credentialsMissing: "The Task Source has no Jira credentials. Add them in Task settings.",
  credentialsInvalid: "Jira refused the Task Source's credentials.",
  credentialsUnavailable: "The Task Source's credentials could not be read on this computer.",
  scopeInvalid: "Jira does not accept this issue or text.",
  rateLimited: "Jira is limiting requests. Try again in a minute.",
  providerUnavailable: "Jira could not be reached.",
  responseTooLarge: "Jira's answer was too large to read.",
  malformedResponse: "Jira answered in a way TermLoop does not understand.",
  forbidden: "The Task Source's Jira account may not change this issue.",
  notFound: "Jira no longer has this issue, or the account cannot see it.",
  rejected: "Jira rejected the change.",
};

/// What to tell the Project Manager about a failed Jira read or change.
export function jiraFailureText(result: ProjectManagerJiraIssueResult): string {
  return result.failureReason ? FAILURES[result.failureReason] : "Jira could not be changed.";
}

/// The ticket as Jira holds it, in the editor's Markdown.
function jiraTicket(issue: JiraIssueTextDto): TicketDraft {
  return { title: issue.summary, brief: issue.description ? jiraWikiToMarkdown(issue.description) : "" };
}

type SyncState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; issue: JiraIssueTextDto; notice?: string };

/// Compares a Jira-linked Task's saved ticket with its Jira issue. The
/// Project Manager either replaces the issue's summary and description with
/// the ticket, after a confirmation, or saves Jira's text as the next ticket
/// version.
export function ProjectManagerJiraSync(props: {
  taskId: string;
  issueKey: string;
  /// The saved ticket version and its text; without one there is nothing
  /// of the Project Manager's to send.
  version: number | null;
  ticket: TicketDraft;
  /// Unsaved edits are neither sent nor overwritten.
  dirty: boolean;
  disabled: boolean;
  read(taskId: string): Promise<ProjectManagerJiraIssueResult>;
  push(taskId: string, expectedTicketVersion: number, expectedJiraUpdated: string): Promise<ProjectManagerJiraIssueResult>;
  /// Saves Jira's text as the ticket's next version; answers with the failure.
  pull(ticket: TicketDraft): Promise<string | undefined>;
  close(): void;
}) {
  const [state, setState] = useState<SyncState>({ kind: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const read = async () => {
    setState({ kind: "loading" });
    try {
      const result = await props.read(props.taskId);
      setState(result.issue ? { kind: "ready", issue: result.issue } : { kind: "failed", message: jiraFailureText(result) });
    } catch (error) {
      setState({ kind: "failed", message: errorText(error) });
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void read(); }, [props.taskId]);

  const push = async (issue: JiraIssueTextDto) => {
    if (props.version === null) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await props.push(props.taskId, props.version, issue.updated);
      if (result.outcome === "updated") {
        setState({ kind: "ready", issue: result.issue ?? issue, notice: `${props.issueKey} now has v${props.version}.` });
      } else if (result.outcome === "jiraChanged" && result.issue) {
        setState({ kind: "ready", issue: result.issue, notice: "Jira changed since you looked. Review its text again before replacing it." });
      } else {
        setMessage(jiraFailureText(result));
      }
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const pull = async (issue: JiraIssueTextDto) => {
    setBusy(true);
    setMessage(undefined);
    const failure = await props.pull(jiraTicket(issue));
    setBusy(false);
    if (failure) setMessage(failure);
    else props.close();
  };

  const jira = state.kind === "ready" ? jiraTicket(state.issue) : undefined;
  const same = jira !== undefined && jira.title.trim() === props.ticket.title.trim() && jira.brief.trim() === props.ticket.brief.trim();
  const locked = props.disabled || busy || props.dirty;

  return <div className="dialog-layer" onKeyDown={(event) => { if (event.key === "Escape") props.close(); }}>
    <button className="dialog-backdrop" aria-label="Close Jira sync" onClick={props.close} />
    <section className="dialog-card pm-jira-sync" role="dialog" aria-modal="true" aria-labelledby="pm-jira-sync-heading">
      <header className="dialog-header">
        <div><span className="dialog-eyebrow">{props.issueKey}</span><h2 id="pm-jira-sync-heading">Sync with Jira</h2></div>
        <button className="icon-button quiet" aria-label="Close dialog" onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body pm-jira-sync-body">
        {state.kind === "loading" ? <p className="td-note">Reading {props.issueKey} from Jira…</p> : null}
        {state.kind === "failed" ? <div className="pm-banner danger" role="alert">
          <span>{state.message}</span>
          <button type="button" className="td-mini" onClick={() => void read()}>Try again</button>
        </div> : null}
        {state.kind === "ready" && jira ? <>
          {state.notice ? <div className="pm-banner" role="status"><span>{state.notice}</span></div> : null}
          {message ? <div className="pm-banner danger" role="alert"><span>{message}</span></div> : null}
          {props.dirty ? <p className="td-note">Save or discard your edits first.</p> : null}
          {same ? <p className="pm-jira-sync-same"><Icon name="check" />Jira and TermLoop say the same.</p> : null}
          <div className="pm-jira-sync-sides">
            <section aria-label="In Jira">
              <h3>In Jira</h3>
              <p className="pm-jira-sync-title">{jira.title}</p>
              <pre className="pm-proposal-brief">{jira.brief || "No description"}</pre>
            </section>
            <section aria-label="In TermLoop">
              <h3>In TermLoop{props.version !== null ? ` · v${props.version}` : ""}</h3>
              <p className="pm-jira-sync-title">{props.ticket.title}</p>
              <pre className="pm-proposal-brief">{props.ticket.brief || "No description"}</pre>
            </section>
          </div>
          {confirming ? <div className="pm-banner warning" role="status">
            <Icon name="alert" />
            <span>This replaces {props.issueKey}'s summary and description in Jira for everyone who reads it.</span>
            <button type="button" className="td-mini danger" disabled={busy} onClick={() => void push(state.issue)}>
              {busy ? "Updating…" : "Update Jira"}
            </button>
            <button type="button" className="td-mini" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div> : null}
        </> : null}
      </div>
      {state.kind === "ready" && !same && !confirming ? <footer className="dialog-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={locked}
          title="Save Jira's summary and description as the ticket's next version"
          onClick={() => void pull(state.issue)}
        >Use Jira's version</button>
        <button
          type="button"
          className="primary-button"
          disabled={locked || props.version === null}
          title={props.version === null ? "Save a ticket version first" : `Replace ${props.issueKey}'s summary and description with v${props.version}`}
          onClick={() => setConfirming(true)}
        >Update Jira…</button>
      </footer> : null}
    </section>
  </div>;
}
