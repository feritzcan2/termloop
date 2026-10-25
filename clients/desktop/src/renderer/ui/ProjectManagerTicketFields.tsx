import { useState, type ReactNode } from "react";
import type {
  EnvironmentDeployState,
  EnvironmentFactDto,
  ProjectManagerEnvironmentSetParams,
  PullRequestFactDto,
  TaskDeliveryFactsDto,
} from "@termloop/contract/current";

import { Icon } from "./Icon.js";
import { ENVIRONMENT_STATES, environmentStateLabel, factSourceLabel, relativeTime } from "./project-manager-ticket.js";
import { projectManagerFindingsSections } from "./ProjectManagerWorkspace.js";

const SUGGESTED_ENVIRONMENTS = ["Dev", "Staging", "Production"];
const MAX_ENVIRONMENTS = 12;

type EnvironmentCommand = Omit<ProjectManagerEnvironmentSetParams, "taskId">;

const PULL_REQUEST_STATES: Record<PullRequestFactDto["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

const CHECK_STATES: Record<PullRequestFactDto["checks"], string | null> = {
  passing: "Checks pass",
  failing: "Checks fail",
  pending: "Checks running",
  unknown: null,
};

const READ_FAILURES: Record<string, string> = {
  credentialsMissing: "not connected",
  credentialsInvalid: "the credentials were rejected",
  credentialsUnavailable: "the credentials are unavailable",
  unauthorized: "the CLI is not signed in",
  noRemote: "the checkout has no GitHub or Azure DevOps remote",
  unsupportedHost: "the remote is not GitHub or Azure DevOps",
  providerUnavailable: "the service or its CLI is unavailable",
  offline: "offline",
  rateLimited: "rate limited",
  timeout: "timed out",
};

/// What TermLoop knows about a Task's delivery: Jira, its pull requests, and
/// its environments, each with where it came from and when. Only the
/// environments can be corrected here; the rest is read again on schedule.
export function ProjectManagerDeliveryFacts(props: {
  facts: TaskDeliveryFactsDto | undefined;
  disabled: boolean;
  openExternal(url: string): void;
  setEnvironment(command: EnvironmentCommand): Promise<string | undefined>;
}) {
  const { facts } = props;
  const jira = facts?.jira ?? null;
  const pullRequests = facts?.pullRequests ?? null;
  const notes = facts?.checkNotes ?? null;
  const sections = notes ? projectManagerFindingsSections(notes.markdown) : [];
  return <section className="pm-doc-section pm-facts" aria-label="Delivery facts">
    <div className="pm-doc-section-head"><h2>Delivery facts</h2></div>
    {facts && facts.readFailures.length > 0 ? <ul className="pm-fact-failures" role="status">
      {facts.readFailures.map((failure) => <li key={failure.source}>
        <Icon name="alert" />
        {factSourceLabel(failure.source)} could not be read: {READ_FAILURES[failure.reason] ?? failure.reason} · {relativeTime(failure.atEpochMs)}
      </li>)}
    </ul> : null}
    <dl className="pm-props">
      <div className="pm-prop">
        <dt><Icon name="check" />Jira</dt>
        <dd>{jira ? <span className="pm-fact">
          <strong>{jira.status}</strong>
          {jira.assignee ? <span>{jira.assignee}</span> : <span className="pm-dim">Unassigned</span>}
          <span className="pm-fact-source" title={`Changed ${relativeTime(jira.changedAtEpochMs)}`}>Read {relativeTime(jira.observedAtEpochMs)}</span>
        </span> : <span className="pm-dim">Not read yet</span>}</dd>
      </div>
      <div className="pm-prop">
        <dt><Icon name="branch" />Pull requests</dt>
        <dd>{pullRequests === null ? <span className="pm-dim">Not read yet</span>
          : pullRequests.items.length === 0 ? <span className="pm-dim">None names this Task's Jira key in {pullRequests.repository}</span>
          : <ul className="pm-pr-facts">
            {pullRequests.items.map((pullRequest) => <li key={pullRequest.number} className={`pm-pr-fact ${pullRequest.state}`}>
              <button type="button" className="pm-pr-link" title="Open the pull request" onClick={() => props.openExternal(pullRequest.url)}>
                #{pullRequest.number}<Icon name="external" />
              </button>
              <span className="pm-pr-title">{pullRequest.title}</span>
              <span className="pm-pr-state">{PULL_REQUEST_STATES[pullRequest.state]}</span>
              {CHECK_STATES[pullRequest.checks] ? <span className={`pm-pr-checks ${pullRequest.checks}`}>{CHECK_STATES[pullRequest.checks]}</span> : null}
            </li>)}
            {pullRequests.truncated ? <li className="pm-dim">More pull requests name this key.</li> : null}
          </ul>}
        </dd>
      </div>
    </dl>
    <ProjectManagerEnvironments
      environments={facts?.environments ?? []}
      disabled={props.disabled}
      setEnvironment={props.setEnvironment}
    />
    {notes ? <details className="pm-findings-card" aria-label="Delivery check notes">
      <summary><h3>Delivery check notes</h3><span className="pm-dim">{relativeTime(notes.recordedAtEpochMs)}</span></summary>
      <div className="pm-findings">
        {sections.map((section, index) => <div key={index} className={`pm-finding ${section.tone}`}>
          <h3>{section.title}</h3>
          <ul>{section.lines.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}</ul>
        </div>)}
      </div>
    </details> : null}
  </section>;
}

/// The environments a Task's change ships through. A delivery check or a
/// probe records them; the Project Manager can state or correct one.
function ProjectManagerEnvironments(props: {
  environments: readonly EnvironmentFactDto[];
  disabled: boolean;
  setEnvironment(command: EnvironmentCommand): Promise<string | undefined>;
}) {
  const { environments } = props;
  const [other, setOther] = useState<string>();
  const [message, setMessage] = useState<string>();
  const run = async (command: EnvironmentCommand) => {
    setMessage(undefined);
    const failure = await props.setEnvironment(command);
    if (failure) setMessage(failure);
    return failure;
  };
  const missing = SUGGESTED_ENVIRONMENTS.filter((name) =>
    !environments.some((environment) => environment.name.toLowerCase() === name.toLowerCase()));
  const room = environments.length < MAX_ENVIRONMENTS;
  return <div className="pm-env" aria-label="Environments">
    <div className="pm-doc-section-head">
      <h3>Environments</h3>
      <div className="pm-env-add">
        {room ? missing.map((name) => <button key={name} type="button" className="pm-chip" disabled={props.disabled}
          onClick={() => void run({ name, state: "unknown" })}>
          <Icon name="add" />{name}
        </button>) : null}
        {room && other === undefined ? <button type="button" className="pm-chip" disabled={props.disabled} onClick={() => setOther("")}>
          <Icon name="add" />Other
        </button> : null}
      </div>
    </div>
    {other !== undefined ? <form className="pm-env-other" onSubmit={(event) => {
      event.preventDefault();
      const name = other.trim();
      if (name) void run({ name, state: "unknown" }).then((failure) => { if (!failure) setOther(undefined); });
    }}>
      <input aria-label="New environment" autoFocus value={other} maxLength={120} placeholder="Environment"
        onChange={(event) => setOther(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setOther(undefined); }} />
      <button type="submit" className="td-mini" disabled={!other.trim()}>Add</button>
    </form> : null}
    {message ? <p className="form-error" role="alert">{message}</p> : null}
    {environments.length === 0
      ? <p className="td-note">No environment yet. A delivery check adds the ones the change ships through.</p>
      : <ul className="pm-env-rows">
        {environments.map((environment) => <li key={environment.name} className={`pm-env-row ${environment.state}`}>
          <i className="pm-env-dot" aria-hidden="true" />
          <span className="pm-env-name">{environment.name}</span>
          <select aria-label={`${environment.name} state`} value={environment.state} disabled={props.disabled}
            onChange={(event) => void run({ name: environment.name, state: event.target.value as EnvironmentDeployState, detail: environment.detail })}>
            {ENVIRONMENT_STATES.map((state) => <option key={state.value} value={state.value}>{state.label}</option>)}
          </select>
          <span className="pm-env-detail">{environment.detail ?? ""}</span>
          <span className="pm-fact-source" title={`${environmentStateLabel(environment.state)} since ${relativeTime(environment.changedAtEpochMs)}`}>
            {factSourceLabel(environment.source)} · {relativeTime(environment.observedAtEpochMs)}
          </span>
          <button type="button" className="icon-button quiet" aria-label={`Remove ${environment.name}`} disabled={props.disabled}
            onClick={() => void run({ name: environment.name, remove: true })}>
            <Icon name="close" />
          </button>
        </li>)}
      </ul>}
  </div>;
}

/// A textarea that grows with its content, for blockers and notes. It is
/// committed when it loses focus.
export function ProjectManagerTicketText(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  tone?: "warning";
  hint?: ReactNode;
  change(value: string): void;
  commit(): void;
}) {
  return <section className={`pm-doc-section${props.tone ? ` ${props.tone}` : ""}`} aria-label={props.label}>
    <div className="pm-doc-section-head"><h2>{props.label}</h2></div>
    <textarea
      className="pm-doc-text"
      aria-label={props.label}
      value={props.value}
      rows={Math.min(12, Math.max(2, props.value.split("\n").length + 1))}
      maxLength={4000}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(event) => props.change(event.target.value)}
      onBlur={props.commit}
    />
    {props.hint}
  </section>;
}
