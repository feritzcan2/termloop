import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ProjectManagerTaskTrackingSetParams,
  ProjectManagerTicketSaveParams,
  ProjectManagerTicketVersionsResult,
  ProjectSprintDto,
  TaskTicketHeadDto,
  TaskTrackingDto,
} from "@termloop/contract/current";

import type { AgentStatus, Session, Task } from "../model.js";
import { Icon, agentIconName } from "./Icon.js";
import { agentLabel } from "./workflow-presentation.js";
import { ProjectManagerMarkdownEditor } from "./ProjectManagerMarkdownEditor.js";
import { ProjectManagerTicketEnvironments, ProjectManagerTicketText } from "./ProjectManagerTicketFields.js";
import { ProjectManagerTicketHistory, ticketAuthorLabel } from "./ProjectManagerTicketHistory.js";
import {
  isRevisionConflict,
  relativeTime,
  sameTicket,
  ticketDraft,
  ticketSaveParams,
  type TicketDraft,
} from "./project-manager-ticket.js";
import {
  agentStatusLabel,
  errorText,
  jiraIssueKey,
  projectManagerFindingsSections,
  type PlaybookStepTrack,
} from "./ProjectManagerWorkspace.js";

export type ProjectManagerTicketActions = {
  startTaskAgent(taskId: string, agentId?: string): Promise<string | undefined>;
  requestInvestigation(taskId: string): Promise<string | undefined>;
  openExternal(url: string): void;
  loadTicketVersions(taskId: string): Promise<ProjectManagerTicketVersionsResult>;
};

/// The Project Manager's ticket: one document holding the Task's title, its
/// Markdown description, and its delivery facts, saved together as numbered
/// versions by the Project Manager or the Task Agent. While the Project
/// Manager edits, a version the Agent saves is announced instead of
/// replacing the draft.
export function ProjectManagerTicket(props: {
  task: Task;
  tracking: TaskTrackingDto | undefined;
  head: TaskTicketHeadDto | undefined;
  sprints: readonly ProjectSprintDto[];
  activeSprint: ProjectSprintDto | undefined;
  inActiveSprint: boolean;
  agent: Session | undefined;
  agentStatus: AgentStatus | undefined;
  track: readonly PlaybookStepTrack[];
  agents: readonly { id: string; label: string }[];
  disabled: boolean;
  actions: ProjectManagerTicketActions;
  saveTicket(params: ProjectManagerTicketSaveParams): Promise<string | undefined>;
  restoreTicket(taskId: string, number: number, expectedVersion: number | null): Promise<string | undefined>;
  setTracking(params: ProjectManagerTaskTrackingSetParams): Promise<string | undefined>;
  renderTerminal(sessionId: string): ReactNode;
}) {
  const { task, agent, actions, track, head } = props;
  const headNumber = head?.number ?? null;
  const saved = useMemo(
    () => ticketDraft(task, props.tracking, head !== undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.id, task.title, task.brief, task.jira_url, props.tracking?.updatedAtEpochMs, head !== undefined],
  );
  const [draft, setDraft] = useState<TicketDraft>(saved);
  const [baseVersion, setBaseVersion] = useState(headNumber);
  const [briefBaseline, setBriefBaseline] = useState(saved.brief);
  const [briefTouched, setBriefTouched] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState<"save" | "start" | "check" | "move" | "sprint">();
  const [message, setMessage] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const reloadNext = useRef(false);

  const briefDirty = briefTouched && draft.brief.trim() !== briefBaseline.trim();
  const otherDirty = !sameTicket({ ...draft, brief: saved.brief }, saved);
  const dirty = briefDirty || otherDirty;
  const effective: TicketDraft = { ...draft, brief: briefDirty ? draft.brief : saved.brief };
  const newerVersion = headNumber !== null && headNumber !== baseVersion;

  const load = () => {
    setDraft(saved);
    setBaseVersion(headNumber);
    setBriefBaseline(saved.brief);
    setBriefTouched(false);
    setSummary("");
    setConflict(false);
    setEditorKey((key) => key + 1);
  };
  // A newer saved ticket replaces the draft unless the Project Manager is in
  // the middle of an edit.
  useEffect(() => {
    if (reloadNext.current || !dirty) {
      reloadNext.current = false;
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, headNumber]);

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<string | undefined>) => {
    setBusy(kind);
    setMessage(undefined);
    try {
      const failure = await action();
      if (failure) setMessage(failure);
      return failure;
    } catch (error) {
      setMessage(errorText(error));
      return errorText(error);
    } finally {
      setBusy(undefined);
    }
  };
  const save = async (overwrite = false) => {
    if (!dirty || !effective.title.trim() || props.disabled || busy) return;
    reloadNext.current = true;
    const failure = await run("save", () => props.saveTicket(
      ticketSaveParams(task.id, effective, summary, overwrite ? headNumber : baseVersion),
    ));
    if (failure) {
      reloadNext.current = false;
      if (isRevisionConflict(failure)) {
        setConflict(true);
        setMessage(undefined);
      }
    }
  };
  const restore = (number: number) => {
    reloadNext.current = true;
    return props.restoreTicket(task.id, number, headNumber).then((failure) => {
      if (failure) reloadNext.current = false;
      return failure;
    });
  };
  const trackingWithSprint = (sprintId: string | null): ProjectManagerTaskTrackingSetParams => ({
    taskId: task.id,
    sprintId,
    developer: props.tracking?.developer ?? null,
    jiraStatus: props.tracking?.jiraStatus ?? null,
    environments: (props.tracking?.environments ?? []).map((environment) => ({ ...environment })),
    blockers: props.tracking?.blockers ?? null,
    note: props.tracking?.note ?? null,
  });
  const update = (patch: Partial<TicketDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const findings = useMemo(() => projectManagerFindingsSections(task.steward_brief_markdown?.trim() ?? ""), [task.steward_brief_markdown]);
  const jiraKey = jiraIssueKey(task.jira_url);
  const currentIndex = track.findIndex((step) => step.state === "current");
  const current = currentIndex >= 0 ? track[currentIndex] : undefined;
  const next = currentIndex >= 0 ? track[currentIndex + 1] : undefined;
  const passed = track.filter((step) => step.state === "passed").length;
  const done = track.length > 0 && passed === track.length;
  const agentState = agentStatusLabel(props.agentStatus?.status);
  const agentName = agent ? agentLabel(agent.process.agent_id ?? null) : undefined;
  const agentRunning = agent?.lifecycle_state === "running";
  const sprintId = props.tracking?.sprintId ?? "";
  const selectableSprints = props.sprints.filter((sprint) => sprint.state !== "closed" || sprint.id === sprintId);

  return <div className={`task-detail pm-ticket${agent ? "" : " no-agent"}${historyOpen ? " with-history" : ""}`}>
    <header className="pm-doc-bar">
      <div className="pm-meta">
        {task.jira_url ? <button
          type="button"
          className="pm-meta-key"
          title="Open the issue in Jira"
          onClick={() => actions.openExternal(task.jira_url!)}
        >{jiraKey ?? "Jira"}<Icon name="external" /></button> : <span className="pm-meta-key local">Local Task</span>}
        <label className={`pm-meta-sprint${props.inActiveSprint ? " active" : ""}`}>
          <select
            aria-label="Sprint"
            value={sprintId}
            disabled={props.disabled || busy !== undefined}
            onChange={(event) => void run("sprint", () => props.setTracking(trackingWithSprint(event.target.value || null)))}
          >
            <option value="">Backlog</option>
            {selectableSprints.map((sprint) => <option key={sprint.id} value={sprint.id}>
              {sprint.name}{sprint.state === "active" ? " · active" : sprint.state === "closed" ? " · closed" : ""}
            </option>)}
          </select>
        </label>
        {task.status === "closed" ? <span className="td-status closed">Closed</span> : null}
        {track.length > 0 && props.inActiveSprint ? <span className={`pm-meta-step${done ? " done" : ""}`} title={`${passed} of ${track.length} Playbook steps passed`}>
          <i aria-hidden="true" />{done ? "Delivered" : current?.title ?? track[0]!.title}
        </span> : null}
        {props.inActiveSprint ? <span className={`pm-meta-agent${agent ? "" : " none"}`}>
          <span className={`pm-agent-dot ${props.agentStatus?.status ?? (agent ? "unknown" : "none")}`} aria-hidden="true" />
          {agent ? [agentName, agentState].filter(Boolean).join(" · ") : "No Agent"}
        </span> : null}
      </div>
      <div className="pm-doc-bar-actions">
        {agent ? <button
          type="button"
          className="td-mini"
          disabled={props.disabled || busy !== undefined || !agentRunning}
          title="Ask the Agent to check Jira, pull requests, and environments again and update the ticket"
          onClick={() => void run("check", () => actions.requestInvestigation(task.id))}
        ><Icon name="restart" />{busy === "check" ? "Asking…" : "Check again"}</button> : null}
        <button
          type="button"
          className={`pm-version-badge${historyOpen ? " open" : ""}`}
          aria-pressed={historyOpen}
          title="Show the ticket's versions"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {head ? <>
            <strong>v{head.number}</strong>
            <span className={`pm-version-by ${head.author}`}>{ticketAuthorLabel(head.author)}</span>
            <span>{relativeTime(head.createdAtEpochMs)}</span>
          </> : <strong>History</strong>}
          <Icon name="history" />
        </button>
      </div>
    </header>

    <div className="pm-ticket-main">
      <div
        className="pm-doc-scroll"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void save();
          }
        }}
      >
        <article className="pm-doc">
          {conflict || (dirty && newerVersion) ? <div className="pm-banner warning" role="status">
            <Icon name="history" />
            <span>
              {head?.author === "agent" ? "The Agent" : "Someone"} saved v{headNumber} while you were editing.
              {conflict ? " Saving yours would replace it." : ""}
            </span>
            <button type="button" className="td-mini" onClick={() => setHistoryOpen(true)}>See changes</button>
            <button type="button" className="td-mini" onClick={load}>Load v{headNumber}</button>
            {conflict ? <button type="button" className="td-mini danger" disabled={busy !== undefined} onClick={() => void save(true)}>Save mine anyway</button> : null}
          </div> : null}
          {message ? <div className="pm-banner danger" role="alert"><span>{message}</span></div> : null}
          {!props.inActiveSprint ? <div className="pm-banner">
            <span>
              Agents run only for Tasks in the active sprint{props.activeSprint ? ` (${props.activeSprint.name})` : ""}. The ticket stays as it is.
            </span>
            {props.activeSprint && task.status === "open" ? <button type="button" className="td-mini" disabled={props.disabled || busy !== undefined}
              onClick={() => void run("move", () => props.setTracking(trackingWithSprint(props.activeSprint!.id)))}>
              {busy === "move" ? "Moving…" : `Move to ${props.activeSprint.name}`}
            </button> : null}
          </div> : !agent ? <div className="pm-banner">
            <span>{props.agents.length === 0 ? "No Agent CLI is available. Set one up in Settings." : "The Task Agent is starting. If it does not appear, start it with:"}</span>
            {props.agents.length > 0 ? <div className="pm-agent-choices" role="group" aria-label="Start the Task Agent">
              {props.agents.map((choice) => <button
                key={choice.id}
                type="button"
                className={`td-mini agent-${choice.id}`}
                disabled={props.disabled || busy !== undefined}
                onClick={() => void run("start", () => actions.startTaskAgent(task.id, choice.id))}
              ><Icon name={agentIconName(choice.id)} />{busy === "start" ? "Starting…" : `Start with ${choice.label}`}</button>)}
            </div> : null}
          </div> : null}

          <textarea
            className="pm-doc-title"
            aria-label="Task title"
            value={draft.title}
            rows={1}
            maxLength={160}
            placeholder="Untitled Task"
            disabled={props.disabled}
            onChange={(event) => update({ title: event.target.value.replace(/\n/gu, " ") })}
          />

          <dl className="pm-props">
            <div className="pm-prop">
              <dt><Icon name="agent" />Developer</dt>
              <dd><input aria-label="Developer" value={draft.developer} placeholder="Empty" maxLength={120} disabled={props.disabled}
                onChange={(event) => update({ developer: event.target.value })} /></dd>
            </div>
            <div className="pm-prop">
              <dt><Icon name="check" />Jira status</dt>
              <dd><input aria-label="Jira status" value={draft.jiraStatus} placeholder="Empty" maxLength={120} disabled={props.disabled}
                onChange={(event) => update({ jiraStatus: event.target.value })} /></dd>
            </div>
            {track.length > 0 ? <div className="pm-prop">
              <dt><Icon name="branch" />Delivery</dt>
              <dd className="pm-delivery">
                <div className="pm-progress" aria-hidden="true">
                  {track.map((step) => <i key={step.id} className={step.state} title={step.title} />)}
                </div>
                <span className="pm-delivery-now">{done ? "Delivered" : current?.title ?? "Not placed on the Playbook yet"}</span>
                {current?.evidence ? <span className="pm-evidence">{current.evidence}</span> : null}
                {next ? <span className="pm-dim">Next: {next.title}</span> : null}
              </dd>
            </div> : null}
          </dl>

          <section className="pm-doc-section" aria-label="Description">
            <ProjectManagerMarkdownEditor
              key={task.id}
              value={saved.brief}
              resetKey={`${task.id}:${editorKey}`}
              disabled={props.disabled}
              label="Task description"
              placeholder="Describe the goal, scope, acceptance criteria, and links. Type # for a heading, - for a list, [ ] for a checklist."
              onBaseline={setBriefBaseline}
              onChange={(markdown) => { setBriefTouched(true); update({ brief: markdown }); }}
            />
            {task.jira_url ? <p className="td-note">Edits stay in TermLoop; Jira is not changed.</p> : null}
          </section>

          <ProjectManagerTicketEnvironments
            environments={draft.environments}
            disabled={props.disabled}
            change={(environments) => update({ environments })}
          />
          <div className="pm-doc-pair">
            <ProjectManagerTicketText label="Blockers" tone="warning" value={draft.blockers} placeholder="What stops delivery right now" disabled={props.disabled}
              change={(blockers) => update({ blockers })} />
            <ProjectManagerTicketText label="Note" value={draft.note} placeholder="Your own note; the Agent never changes it" disabled={props.disabled}
              change={(note) => update({ note })} />
          </div>

          {findings.length > 0 ? <details className="pm-doc-section pm-findings-card" aria-label="Agent findings">
            <summary><h2>Agent findings</h2><span className="pm-dim">How the Agent knows</span></summary>
            <div className="pm-findings">
              {findings.map((section, index) => <div key={index} className={`pm-finding ${section.tone}`}>
                <h3>{section.title}</h3>
                <ul>{section.lines.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}</ul>
              </div>)}
            </div>
          </details> : null}
        </article>
      </div>
      {historyOpen ? <ProjectManagerTicketHistory
        taskId={task.id}
        headVersion={headNumber}
        disabled={props.disabled}
        load={actions.loadTicketVersions}
        restore={restore}
        close={() => setHistoryOpen(false)}
      /> : null}
    </div>

    {dirty ? <footer className="pm-save-bar">
      <span className="pm-save-state"><i aria-hidden="true" />Unsaved changes</span>
      <input
        className="pm-save-summary"
        aria-label="What changed"
        value={summary}
        maxLength={200}
        placeholder="What changed? (optional, shown in History)"
        onChange={(event) => setSummary(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void save(); }}
      />
      <button type="button" className="td-mini" disabled={busy !== undefined} onClick={load}>Discard</button>
      <button
        type="button"
        className="primary-button pm-save"
        disabled={props.disabled || busy !== undefined || !effective.title.trim()}
        title="Save as a new version (⌘S)"
        onClick={() => void save()}
      >{busy === "save" ? "Saving…" : "Save version"}</button>
    </footer> : null}

    {agent ? <div className="pm-terminal">
      <div className="pm-terminal-head">
        <Icon name="terminal" /><span>{agentName} terminal</span>
      </div>
      <div className="pm-terminal-body">{props.renderTerminal(agent.id)}</div>
    </div> : null}
  </div>;
}
