// The Jira browser's board (Orca's task-page Jira board, read-only): lanes
// from the board's columns, or by status category when the board has none.
// The PM daemon has no Jira transition method for the browser, so cards do
// not drag between lanes.
import type { PmJiraIssue } from "@termloop/pm-contract/pm";
import { JiraAssignee, JiraIssueRowActions, type JiraIssueActions } from "./JiraIssueList.js";
import { priorityTone, type JiraBoardLane } from "./jira-view-state.js";

export function JiraBoard(props: { lanes: JiraBoardLane[]; actions: JiraIssueActions }) {
  return (
    <div className="jira-board" aria-label="Jira board">
      {props.lanes.map((lane) => (
        <section key={lane.key} className="jira-lane" aria-label={lane.label}>
          <header className="jira-lane-head">
            <span>{lane.label}</span>
            <span className="count-badge">{lane.issues.length}</span>
          </header>
          <div className="jira-lane-body">
            {lane.issues.length === 0 ? <p className="jira-lane-empty">No issues</p> : lane.issues.map((issue) => <JiraCard key={issue.id} issue={issue} actions={props.actions} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function JiraCard({ issue, actions }: { issue: PmJiraIssue; actions: JiraIssueActions }) {
  const tone = priorityTone(issue.priority);
  return (
    <article className="jira-card" data-key={issue.key}>
      <div className="jira-card-top">
        <span className="jira-key">{issue.key}</span>
        <span className="sp" />
        {issue.priority && <span className={`jira-priority ${tone ?? ""}`}>{issue.priority}</span>}
        <JiraAssignee issue={issue} compact />
      </div>
      <p className="jira-card-title">{issue.title}</p>
      <div className="jira-card-actions"><JiraIssueRowActions issue={issue} actions={actions} /></div>
    </article>
  );
}
