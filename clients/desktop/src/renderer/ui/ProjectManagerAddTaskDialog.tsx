import { useState } from "react";
import type {
  ProjectManagerJiraIssueDto,
  ProjectManagerJiraSearchResult,
  ProjectManagerTaskCreateParams,
  ProjectSprintDto,
} from "@termloop/contract/current";

import { Icon } from "./Icon.js";
import { jiraWikiToMarkdown } from "./project-manager-ticket.js";

type JiraSearchState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; issues: readonly ProjectManagerJiraIssueDto[]; truncated: boolean }
  | { kind: "failed"; message: string; needsSetup: boolean };

export function jiraSearchFailureMessage(reason: ProjectManagerJiraSearchResult["failureReason"]): string {
  switch (reason) {
    case "credentialsMissing":
    case "credentialsInvalid":
    case "credentialsUnavailable": return "Jira rejected or is missing your credentials.";
    case "rateLimited": return "Jira is rate limiting requests. Try again shortly.";
    case "scopeInvalid": return "Jira could not run this search.";
    default: return "Jira is not reachable right now.";
  }
}

/// Adds a local Task to a sprint or the backlog: typed in, or copied from one
/// Jira issue found by key or text. Copying keeps the issue link; the Task
/// stays TermLoop's own.
export function ProjectManagerAddTaskDialog(props: {
  sprints: readonly ProjectSprintDto[];
  defaultSprintId: string | null;
  searchJira(query: string): Promise<ProjectManagerJiraSearchResult>;
  create(params: Omit<ProjectManagerTaskCreateParams, "projectId">): Promise<string | undefined>;
  openTaskSources(): void;
  close(): void;
}) {
  const [mode, setMode] = useState<"jira" | "blank">("jira");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<JiraSearchState>({ kind: "idle" });
  const [copied, setCopied] = useState<ProjectManagerJiraIssueDto>();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [sprintId, setSprintId] = useState(props.defaultSprintId ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const openSprints = props.sprints.filter((sprint) => sprint.state !== "closed");

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearch({ kind: "searching" });
    try {
      const result = await props.searchJira(query.trim());
      setSearch(result.failureReason
        ? { kind: "failed", message: jiraSearchFailureMessage(result.failureReason), needsSetup: result.failureReason.startsWith("credentials") }
        : { kind: "done", issues: result.issues, truncated: result.truncated });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const needsSetup = text.includes("taskSource");
      setSearch({ kind: "failed", needsSetup, message: needsSetup ? "Connect Jira in Task settings to search it." : text });
    }
  };

  const copy = (issue: ProjectManagerJiraIssueDto) => {
    setCopied(issue);
    setTitle(issue.summary.slice(0, 160));
    setBrief(jiraWikiToMarkdown(issue.description ?? "").slice(0, 8000));
  };

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setMessage(undefined);
    const failure = await props.create({
      title: title.trim(),
      brief: brief.trim() || null,
      sprintId: sprintId || null,
      jiraUrl: copied?.url ?? null,
      developer: copied?.assigneeDisplay?.slice(0, 120) ?? null,
    });
    setBusy(false);
    if (failure) setMessage(failure.includes("jiraUrl") ? "This Jira issue is already a Task here." : failure);
    else props.close();
  };

  const form = <>
    {copied ? <div className="pm-copied">
      <span className="pm-meta-key">{copied.key}</span>
      <span>Copied from Jira · {copied.statusName}{copied.assigneeDisplay ? ` · ${copied.assigneeDisplay}` : ""}</span>
      <button type="button" className="icon-button quiet" aria-label="Clear the copied issue" onClick={() => { setCopied(undefined); setTitle(""); setBrief(""); }}>
        <Icon name="close" />
      </button>
    </div> : null}
    <label htmlFor="pm-add-title">Title</label>
    <input id="pm-add-title" value={title} maxLength={160} placeholder="What has to be delivered" onChange={(event) => setTitle(event.target.value)} />
    <label htmlFor="pm-add-brief">Description (Markdown)</label>
    <textarea id="pm-add-brief" value={brief} maxLength={8000} onChange={(event) => setBrief(event.target.value)} />
    <label htmlFor="pm-add-sprint">Sprint</label>
    <select id="pm-add-sprint" value={sprintId} onChange={(event) => setSprintId(event.target.value)}>
      <option value="">Backlog</option>
      {openSprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.name}{sprint.state === "active" ? " (active)" : ""}</option>)}
    </select>
  </>;

  return <div className="dialog-layer" onKeyDown={(event) => { if (event.key === "Escape") props.close(); }}>
    <button className="dialog-backdrop" aria-label="Cancel adding Task" onClick={props.close} />
    <section className="dialog-card pm-add-dialog" role="dialog" aria-modal="true" aria-labelledby="pm-add-title-heading">
      <header className="dialog-header">
        <div><span className="dialog-eyebrow">Project Manager</span><h2 id="pm-add-title-heading">Add Task</h2></div>
        <button className="icon-button quiet" aria-label="Close dialog" onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="pm-add-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "jira"} className={mode === "jira" ? "selected" : undefined} onClick={() => setMode("jira")}>Copy from Jira</button>
        <button type="button" role="tab" aria-selected={mode === "blank"} className={mode === "blank" ? "selected" : undefined} onClick={() => { setMode("blank"); setCopied(undefined); }}>New</button>
      </div>
      <div className="dialog-body pm-add-body">
        {mode === "jira" && !copied ? <>
          <form className="pm-jira-search" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
            <input
              aria-label="Search Jira"
              autoFocus
              value={query}
              maxLength={200}
              placeholder="Issue key (PAY-42) or words from the title"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="secondary-button" disabled={!query.trim() || search.kind === "searching"}>
              {search.kind === "searching" ? "Searching…" : "Search"}
            </button>
          </form>
          {search.kind === "failed" ? <div className="pm-jira-failure" role="alert">
            <span>{search.message}</span>
            {search.needsSetup ? <button type="button" className="td-mini" onClick={() => { props.close(); props.openTaskSources(); }}>Open Jira settings</button> : null}
          </div> : null}
          {search.kind === "done" ? search.issues.length === 0
            ? <p className="td-note">No issue matches.</p>
            : <ul className="pm-jira-results" aria-label="Jira issues">
              {search.issues.map((issue) => <li key={issue.key}>
                <button type="button" disabled={Boolean(issue.taskId)} onClick={() => copy(issue)}>
                  <span className="pm-meta-key">{issue.key}</span>
                  <span className="pm-jira-summary">{issue.summary}</span>
                  <span className="pm-jira-meta">{issue.taskId ? "Already a Task" : [issue.statusName, issue.assigneeDisplay].filter(Boolean).join(" · ")}</span>
                </button>
              </li>)}
              {search.truncated ? <li className="td-note">More issues match; narrow the search.</li> : null}
            </ul> : null}
        </> : form}
        {message ? <p className="form-error" role="alert">{message}</p> : null}
      </div>
      <footer className="dialog-actions">
        <button type="button" className="secondary-button" onClick={props.close}>Cancel</button>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !title.trim() || (mode === "jira" && !copied)}
          onClick={() => void submit()}
        >{busy ? "Adding…" : "Add Task"}</button>
      </footer>
    </section>
  </div>;
}
