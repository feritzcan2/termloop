import { useEffect, useState } from "react";
import type {
  GitHostProjectionReason,
  GitHostRepositoryPullRequestDto,
  GitHostRepositoryPullRequestFilter,
  GitHostRepositoryPullRequestListResult,
} from "@termloop/contract/current";
import { controlErrorMessage } from "../control-error.js";
import { integrationMethodUnavailable } from "../integration-status.js";
import { relativeTime } from "../task-sources.js";
import { Icon } from "./Icon.js";
import "../../pull-requests.css";

const FILTERS: readonly { filter: GitHostRepositoryPullRequestFilter; label: string }[] = [
  { filter: "authored", label: "Mine" },
  { filter: "reviewRequested", label: "Review requested" },
  { filter: "all", label: "All" },
];

function repositoryPullRequestReasonCopy(reason: GitHostProjectionReason): string {
  switch (reason) {
    case "noRemote": return "This Project has no Git remote.";
    case "unsupportedHost": return "The Project's remote is not on GitHub or Azure DevOps.";
    case "malformedRemote": return "The Project's remote URL cannot identify a repository. Remotes with embedded credentials are ignored.";
    case "gitUnavailable":
    case "unsupportedGit": return "Git is unavailable or too old on this computer.";
    case "repositoryUnavailable": return "The Project folder is not a readable Git repository.";
    case "providerUnavailable": return "The provider CLI is not installed or not connected. Check Settings → Integrations.";
    case "unauthorized": return "The provider rejected the credentials. Reconnect it in Settings → Integrations.";
    case "offline": return "The provider could not be reached.";
    case "rateLimited": return "The provider is rate limiting requests. Try again later.";
    case "timeout": return "The provider took too long to answer.";
    default: return "The provider returned an unusable answer.";
  }
}

function repositoryLabel(result: GitHostRepositoryPullRequestListResult): string | undefined {
  if (!result.repository_owner || !result.repository_name) return undefined;
  return [result.repository_owner, result.repository_project, result.repository_name].filter(Boolean).join("/");
}

function errorCopy(error: unknown): string {
  return integrationMethodUnavailable(error)
    ? "This computer's TermLoop server is too old to list pull requests. Update it, then refresh."
    : controlErrorMessage(error);
}

/// Open pull requests of the selected Project's GitHub or Azure DevOps
/// repository. Read-only: each row opens the provider page.
export function PullRequestsSidebar({ projectId, load, openExternal, close, unavailable }: {
  projectId: string | undefined;
  load(projectId: string, filter: GitHostRepositoryPullRequestFilter): Promise<GitHostRepositoryPullRequestListResult>;
  openExternal(url: string): void;
  close(): void;
  unavailable: boolean;
}) {
  const [filter, setFilter] = useState<GitHostRepositoryPullRequestFilter>("authored");
  const [reloadToken, setReloadToken] = useState(0);
  const [result, setResult] = useState<GitHostRepositoryPullRequestListResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId || unavailable) return;
    let current = true;
    setLoading(true);
    setError(undefined);
    load(projectId, filter).then(
      (next) => { if (current) setResult(next); },
      (failure: unknown) => { if (current) { setResult(undefined); setError(errorCopy(failure)); } },
    ).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [projectId, filter, reloadToken, unavailable, load]);

  const repository = result ? repositoryLabel(result) : undefined;
  return <aside className="files-sidebar pull-requests-sidebar" aria-label="Pull Requests">
    <header className="files-sidebar-header">
      <h2>Pull Requests</h2>
      <span className="pull-requests-header-actions">
        <button type="button" className="icon-button quiet" aria-label="Refresh pull requests" title="Refresh pull requests"
          disabled={!projectId || unavailable || loading} onClick={() => setReloadToken((token) => token + 1)}><Icon name="restart" /></button>
        <button type="button" className="icon-button quiet" aria-label="Close Pull Requests sidebar" title="Close Pull Requests sidebar" onClick={close}><Icon name="close" /></button>
      </span>
    </header>
    <div className="pull-requests-filters" role="group" aria-label="Pull request filter">
      {FILTERS.map((option) => <button key={option.filter} type="button" aria-pressed={filter === option.filter}
        className={filter === option.filter ? "selected" : undefined} onClick={() => setFilter(option.filter)}>{option.label}</button>)}
    </div>
    {repository ? <p className="pull-requests-repository" title={repository}>{repository}</p> : null}
    <div className="files-sidebar-body" aria-busy={loading}>
      {!projectId ? <p className="files-sidebar-empty">Select a Project to see its pull requests.</p>
        : unavailable ? <p className="files-sidebar-empty">This Project's computer is not connected.</p>
        : error ? <p className="files-sidebar-empty pull-requests-error" role="alert">{error}</p>
        : !result ? <p className="files-sidebar-empty">Loading pull requests…</p>
        : result.reason ? <p className="files-sidebar-empty pull-requests-error" role="alert">{repositoryPullRequestReasonCopy(result.reason)}</p>
        : result.pull_requests.length === 0 ? <p className="files-sidebar-empty">{filter === "all" ? "No open pull requests." : filter === "authored" ? "You have no open pull requests." : "No pull requests are waiting for your review."}</p>
        : <>
          <ul className="pull-requests-list">
            {result.pull_requests.map((pullRequest) => <li key={pullRequest.url}>
              <PullRequestRow pullRequest={pullRequest} now={result.observed_at_epoch_ms} open={() => openExternal(pullRequest.url)} />
            </li>)}
          </ul>
          {result.truncated ? <p className="files-sidebar-empty">Showing the {result.pull_requests.length} most recently updated. Open the provider to see the rest.</p> : null}
        </>}
    </div>
  </aside>;
}

function PullRequestRow({ pullRequest, now, open }: { pullRequest: GitHostRepositoryPullRequestDto; now: number; open(): void }) {
  const signals = pullRequestSignals(pullRequest);
  return <button type="button" className="pull-request-row" title={`Open #${pullRequest.number} in the browser`} onClick={open}>
    <span className="pull-request-title"><span className="pull-request-number">#{pullRequest.number}</span> {pullRequest.title}</span>
    <span className="pull-request-meta">
      {[pullRequest.author, `${pullRequest.head_branch} → ${pullRequest.base_branch}`, relativeTime(pullRequest.updated_at_epoch_ms, now)].filter(Boolean).join(" · ")}
    </span>
    {signals.length ? <span className="pull-request-signals">
      {signals.map((signal) => <span key={signal.label} className={`pull-request-signal ${signal.tone}`}>{signal.label}</span>)}
    </span> : null}
  </button>;
}

export function pullRequestSignals(pullRequest: GitHostRepositoryPullRequestDto): { label: string; tone: "ok" | "warn" | "danger" | "idle" }[] {
  const signals: { label: string; tone: "ok" | "warn" | "danger" | "idle" }[] = [];
  if (pullRequest.state === "draft") signals.push({ label: "Draft", tone: "idle" });
  if (pullRequest.check_rollup === "passing") signals.push({ label: "Checks passing", tone: "ok" });
  else if (pullRequest.check_rollup === "failing") signals.push({ label: "Checks failing", tone: "danger" });
  else if (pullRequest.check_rollup === "pending") signals.push({ label: "Checks running", tone: "warn" });
  if (pullRequest.review_signal === "approved") signals.push({ label: "Approved", tone: "ok" });
  else if (pullRequest.review_signal === "changesRequested") signals.push({ label: "Changes requested", tone: "danger" });
  else if (pullRequest.review_signal === "reviewRequired") signals.push({ label: "Review required", tone: "warn" });
  if (pullRequest.merge_conflict === "conflicting") signals.push({ label: "Conflicts", tone: "danger" });
  return signals;
}
