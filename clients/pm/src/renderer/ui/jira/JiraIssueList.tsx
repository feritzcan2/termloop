// The Jira browser's list (Orca's task-page Jira issue list): issues grouped
// by status in board order, each group collapsible, with row actions on
// hover: copy key, open or add in PM, open in Jira.
import { useState } from "react";
import type { PmJiraIssue } from "@termloop/pm-contract/pm";
import { relativeTime } from "../format.js";
import { Icon } from "../icons.js";
import { initials, priorityTone, type JiraIssueSection } from "./jira-view-state.js";

export type JiraIssueActions = {
  /** Keys with an "Add to PM" in flight. */
  adding: readonly string[];
  onCopyKey(key: string): void;
  onOpenTicket(ticketId: string): void;
  onAddToPm(issue: PmJiraIssue): void;
  onOpenInJira(url: string): void;
};

export function JiraIssueList(props: { sections: JiraIssueSection[]; now: number; actions: JiraIssueActions }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  return (
    <div className="jira-list" role="table" aria-label="Jira issues">
      <div className="jira-grid jira-list-head" role="row">
        <span role="columnheader">Key</span>
        <span role="columnheader">Issue</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Priority</span>
        <span role="columnheader">Assignee</span>
        <span role="columnheader">Updated</span>
        <span />
      </div>
      {props.sections.map((section) => {
        const open = !collapsed.has(section.key);
        return (
          <div key={section.key} className="jira-section" role="rowgroup">
            <button type="button" className="jira-section-head" aria-expanded={open} onClick={() => toggle(section.key)}>
              <Icon name={open ? "down" : "right"} />
              <span className={`jira-status cat-${section.category}`}>{section.label}</span>
              <span className="count-badge">{section.issues.length}</span>
            </button>
            {open && section.issues.map((issue) => <JiraIssueRow key={issue.id} issue={issue} now={props.now} actions={props.actions} />)}
          </div>
        );
      })}
    </div>
  );
}

function JiraIssueRow({ issue, now, actions }: { issue: PmJiraIssue; now: number; actions: JiraIssueActions }) {
  const labels = issue.labels.slice(0, 3);
  const tone = priorityTone(issue.priority);
  return (
    <div className="jira-grid jira-issue" role="row" data-key={issue.key}>
      <span className="jira-key" role="cell">{issue.key}</span>
      <span className="jira-title" role="cell">
        <span className="jira-title-text" title={issue.title}>{issue.title}</span>
        {labels.map((label) => <span key={label} className="jira-label">{label}</span>)}
        {issue.labels.length > labels.length && <span className="jira-label more">+{issue.labels.length - labels.length}</span>}
      </span>
      <span role="cell"><span className={`jira-status cat-${issue.status.category}`}>{issue.status.name}</span></span>
      <span role="cell" className={`jira-priority ${tone ?? ""}`}>{issue.priority ?? "—"}</span>
      <span role="cell" className="jira-assignee"><JiraAssignee issue={issue} /></span>
      <span role="cell" className="jira-updated">{relativeTime(issue.updatedAtEpochMs, now)}</span>
      <span role="cell" className="jira-row-actions"><JiraIssueRowActions issue={issue} actions={actions} /></span>
    </div>
  );
}

/**
 * Initials only: the renderer's CSP allows no remote images, so Jira avatar
 * URLs are not loaded.
 */
export function JiraAssignee({ issue, compact = false }: { issue: PmJiraIssue; compact?: boolean }) {
  const name = issue.assignee?.displayName;
  return (
    <>
      <span className={`jira-avatar ${name ? "" : "none"}`} title={name ?? "Unassigned"} aria-hidden="true">{name ? initials(name) : ""}</span>
      {!compact && <span className="jira-assignee-name">{name ?? "Unassigned"}</span>}
    </>
  );
}

export function JiraIssueRowActions({ issue, actions }: { issue: PmJiraIssue; actions: JiraIssueActions }) {
  const adding = actions.adding.includes(issue.key);
  return (
    <>
      <button type="button" className="icb" aria-label={`Copy ${issue.key}`} title="Copy key" onClick={() => actions.onCopyKey(issue.key)}>
        <Icon name="copy" />
      </button>
      {issue.pmTicketId ? (
        <button type="button" className="btn sm" title="Open the linked PM ticket" onClick={() => actions.onOpenTicket(issue.pmTicketId!)}>Open in PM</button>
      ) : (
        <button type="button" className="btn sm" title="Create a PM ticket linked to this issue in the active sprint" disabled={adding} onClick={() => actions.onAddToPm(issue)}>
          {adding ? "Adding…" : "Add to PM"}
        </button>
      )}
      <button type="button" className="icb" aria-label={`Open ${issue.key} in Jira`} title="Open in Jira" onClick={() => actions.onOpenInJira(issue.url)}>
        <Icon name="external" />
      </button>
    </>
  );
}
