import { useEffect, useState } from "react";
import type {
  JiraTaskProposalDto,
  ProjectLocalBranchListResult,
  TaskProvisionWorktreeParams,
} from "@termloop/contract/current";
import type { Session } from "../model.js";
import { sessionLabel } from "../model.js";
import { readWorktreeBaseRef } from "../worktree-base-ref-memory.js";
import { sortRemoteBranches, suggestedBranchName, worktreeDestination, worktreePathParent } from "./worktree-path-suggestion.js";

export type JiraTaskSourceChoice = { id: string; name: string };

export type JiraTaskProposalEdit = {
  sourceId: string;
  projectKey: string;
  issueType: string;
  epicKey: string | null;
  summary: string;
  description: string;
};

export type JiraTaskProposalApproval =
  | { outcome: "created"; taskId: string; issueKey: string; issueUrl: string }
  | { outcome: "failed"; failure: string };

export type JiraTaskProposalActions = {
  loadSources(projectId: string): Promise<JiraTaskSourceChoice[]>;
  approve(sessionId: string, proposalId: string, edit: JiraTaskProposalEdit): Promise<JiraTaskProposalApproval>;
  respond(sessionId: string, proposalId: string, decision: "revise" | "dismiss", feedback: string): Promise<string | undefined>;
};

const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

/**
 * The managed worktree an approved Jira Task starts in: a new branch named
 * after the issue, created from the remembered or preferred remote base.
 */
export function jiraTaskWorktreeParams(
  projectId: string,
  repositoryPath: string,
  taskId: string,
  issueKey: string,
  summary: string,
  branches: ProjectLocalBranchListResult,
): TaskProvisionWorktreeParams | string {
  const remote = sortRemoteBranches(branches.base_branches);
  const baseRef = remote.find((branch) => branch.exact_ref === readWorktreeBaseRef(projectId))?.exact_ref
    ?? remote[0]?.exact_ref;
  if (!baseRef) return "This repository has no remote-tracking branch to create the Task worktree from. Fetch a remote branch first.";
  const proposed = suggestedBranchName(`${issueKey} ${summary}`, "task") || `task/${issueKey.toLowerCase()}`;
  const taken = new Set(branches.branches.map((branch) => branch.name));
  const branchName = taken.has(proposed) ? `${proposed}-${globalThis.crypto.randomUUID().slice(0, 4)}` : proposed;
  return {
    operationId: globalThis.crypto.randomUUID(),
    taskId,
    repositoryPath,
    destinationPath: worktreeDestination(worktreePathParent(repositoryPath), branchName),
    branchName,
    branchMode: "create",
    baseRef,
  };
}

/** Agent-proposed Jira issues that wait for the user, one card per Agent. */
export function JiraTaskProposalCards({ sessions, actions, selectSession, started }: {
  sessions: readonly Session[];
  actions: JiraTaskProposalActions;
  selectSession(sessionId: string): void;
  started(session: Session, approval: Extract<JiraTaskProposalApproval, { outcome: "created" }>, summary: string): void;
}) {
  const pending = sessions.filter((session) => session.jira_task_proposal);
  if (!pending.length) return null;
  return <aside className="jira-proposal-stack" aria-label="Jira issue proposals">
    {pending.map((session) => <JiraTaskProposalCard
      key={`${session.id}:${session.jira_task_proposal!.proposal_id}`}
      session={session}
      proposal={session.jira_task_proposal!}
      actions={actions}
      selectSession={selectSession}
      started={started}
    />)}
  </aside>;
}

function JiraTaskProposalCard({ session, proposal, actions, selectSession, started }: {
  session: Session;
  proposal: JiraTaskProposalDto;
  actions: JiraTaskProposalActions;
  selectSession(sessionId: string): void;
  started(session: Session, approval: Extract<JiraTaskProposalApproval, { outcome: "created" }>, summary: string): void;
}) {
  const [sources, setSources] = useState<JiraTaskSourceChoice[]>();
  const [sourceId, setSourceId] = useState("");
  const [projectKey, setProjectKey] = useState(proposal.project_key);
  const [issueType, setIssueType] = useState(proposal.issue_type);
  const [epicKey, setEpicKey] = useState(proposal.epic_key ?? "");
  const [summary, setSummary] = useState(proposal.summary);
  const [description, setDescription] = useState(proposal.description);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void actions.loadSources(session.project_id).then((choices) => {
      if (!live) return;
      setSources(choices);
      setSourceId((current) => current || choices[0]?.id || "");
    }).catch((cause) => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [actions, session.project_id]);

  const creating = proposal.state === "creating";
  const disabled = busy || creating;
  const invalid = !PROJECT_KEY.test(projectKey.trim()) ? "Enter a Jira project key such as PAY."
    : !issueType.trim() ? "Enter an issue type such as Task."
      : epicKey.trim() && !ISSUE_KEY.test(epicKey.trim()) ? "Enter the epic as an issue key such as PAY-12, or leave it empty."
        : !summary.trim() || summary.includes("\n") ? "Enter a one-line summary."
          : !sourceId ? "Connect a Jira Task Source to this Project first."
            : undefined;

  const approve = async () => {
    if (invalid || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await actions.approve(session.id, proposal.proposal_id, {
        sourceId,
        projectKey: projectKey.trim(),
        issueType: issueType.trim(),
        epicKey: epicKey.trim() || null,
        summary: summary.trim(),
        description,
      });
      if (result.outcome === "created") started(session, result, summary.trim());
      else setError(result.failure);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const respond = async (decision: "revise" | "dismiss") => {
    if (disabled || (decision === "revise" && !feedback.trim())) return;
    setBusy(true);
    setError(undefined);
    try {
      const failure = await actions.respond(session.id, proposal.proposal_id, decision, feedback.trim());
      if (failure) setError(failure);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const shownError = error ?? proposal.failure ?? undefined;
  return <section className="jira-proposal-card" aria-labelledby={`jira-proposal-${proposal.proposal_id}`} aria-busy={disabled}>
    <header>
      <h3 id={`jira-proposal-${proposal.proposal_id}`}>Jira issue proposal</h3>
      <button type="button" className="link" onClick={() => selectSession(session.id)}>{sessionLabel(session)}</button>
    </header>
    {proposal.rationale ? <p className="jira-proposal-rationale">{proposal.rationale}</p> : null}
    <div className="jira-proposal-grid">
      {sources && sources.length > 1 ? <label>Source
        <select value={sourceId} disabled={disabled} onChange={(event) => setSourceId(event.target.value)}>
          {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
      </label> : null}
      <label>Project<input value={projectKey} maxLength={32} disabled={disabled} onChange={(event) => setProjectKey(event.target.value.toUpperCase())} /></label>
      <label>Type<input value={issueType} maxLength={60} disabled={disabled} onChange={(event) => setIssueType(event.target.value)} /></label>
      <label>Epic<input value={epicKey} maxLength={64} placeholder="None" disabled={disabled} onChange={(event) => setEpicKey(event.target.value.toUpperCase())} /></label>
    </div>
    <label>Summary<input value={summary} maxLength={255} disabled={disabled} onChange={(event) => setSummary(event.target.value)} /></label>
    <label>Description<textarea value={description} maxLength={32767} rows={6} disabled={disabled} onChange={(event) => setDescription(event.target.value)} /></label>
    {feedbackOpen ? <label>Feedback for the agent
      <textarea value={feedback} maxLength={4000} rows={3} autoFocus disabled={disabled} placeholder="For example: use epic PAY-9 and make it a Story" onChange={(event) => setFeedback(event.target.value)} />
    </label> : null}
    {shownError ? <p role="alert">{shownError}</p> : invalid && sources ? <p role="status">{invalid}</p> : null}
    <footer>
      {creating ? <em>Creating in Jira…</em> : null}
      <button type="button" disabled={disabled} onClick={() => void respond("dismiss")}>Dismiss</button>
      {feedbackOpen
        ? <button type="button" disabled={disabled || !feedback.trim()} onClick={() => void respond("revise")}>Send feedback</button>
        : <button type="button" disabled={disabled} onClick={() => setFeedbackOpen(true)}>Feedback…</button>}
      <button type="button" className="primary" disabled={disabled || Boolean(invalid)} onClick={() => void approve()}>Create issue and start</button>
    </footer>
  </section>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
