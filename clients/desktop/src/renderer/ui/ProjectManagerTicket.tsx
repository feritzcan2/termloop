import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DeliveryCheckDto,
  DeliveryRiskDto,
  ProjectManagerEnvironmentSetParams,
  ProjectManagerJiraIssueResult,
  ProjectManagerTaskTrackingSetParams,
  ProjectManagerTicketSaveParams,
  ProjectManagerTicketVersionsResult,
  ProjectSprintDto,
  TaskDeliveryFactsDto,
  TaskTicketHeadDto,
  TaskTicketProposalDto,
  TaskTrackingDto,
} from "@termloop/contract/current";

import type { Task } from "../model.js";
import { Icon } from "./Icon.js";
import { ProjectManagerJiraSync } from "./ProjectManagerJiraSync.js";
import { ProjectManagerMarkdownEditor } from "./ProjectManagerMarkdownEditor.js";
import { RISK_LABELS } from "./ProjectManagerOverview.js";
import { ProjectManagerDeliveryFacts, ProjectManagerTicketText } from "./ProjectManagerTicketFields.js";
import { ProjectManagerTicketHistory, ticketAuthorLabel } from "./ProjectManagerTicketHistory.js";
import {
  isRevisionConflict,
  relativeTime,
  sameTicket,
  taskDeveloper,
  ticketDraft,
  ticketSaveParams,
  type TicketDraft,
} from "./project-manager-ticket.js";
import { errorText, jiraIssueKey } from "./ProjectManagerWorkspace.js";
import type { StageStep } from "./project-manager-stage.js";

export type ProjectManagerTicketActions = {
  openExternal(url: string): void;
  loadTicketVersions(taskId: string): Promise<ProjectManagerTicketVersionsResult>;
  readJiraIssue(taskId: string): Promise<ProjectManagerJiraIssueResult>;
  pushJiraIssue(taskId: string, expectedTicketVersion: number, expectedJiraUpdated: string): Promise<ProjectManagerJiraIssueResult>;
};

type TrackingDraft = { developer: string; blockers: string; note: string };

function trackingDraft(tracking: TaskTrackingDto | undefined): TrackingDraft {
  return { developer: tracking?.developer ?? "", blockers: tracking?.blockers ?? "", note: tracking?.note ?? "" };
}

/// The Project Manager's ticket: the Task's title and Markdown description,
/// saved together as numbered versions; the Project Manager's own developer,
/// blockers, and note; and the delivery facts TermLoop read. A delivery check
/// only proposes ticket changes, which the Project Manager accepts or
/// dismisses.
export function ProjectManagerTicket(props: {
  task: Task;
  tracking: TaskTrackingDto | undefined;
  facts: TaskDeliveryFactsDto | undefined;
  proposal: TaskTicketProposalDto | undefined;
  check: DeliveryCheckDto | undefined;
  risks: readonly DeliveryRiskDto[];
  head: TaskTicketHeadDto | undefined;
  sprints: readonly ProjectSprintDto[];
  activeSprint: ProjectSprintDto | undefined;
  inActiveSprint: boolean;
  /// Whether the Project's sprints mirror Jira.
  sprintsFromJira: boolean;
  /// Where the Task stands on its way to production.
  track: readonly StageStep[];
  disabled: boolean;
  actions: ProjectManagerTicketActions;
  saveTicket(params: ProjectManagerTicketSaveParams): Promise<string | undefined>;
  restoreTicket(taskId: string, number: number, expectedVersion: number | null): Promise<string | undefined>;
  setTracking(params: ProjectManagerTaskTrackingSetParams): Promise<string | undefined>;
  /// Moves the Jira issue into a sprint mirrored from Jira, or the backlog.
  moveJiraSprint(taskId: string, sprintId: string | null): Promise<string | undefined>;
  setEnvironment(params: ProjectManagerEnvironmentSetParams): Promise<string | undefined>;
  acceptProposal(taskId: string, expectedVersion: number | null): Promise<string | undefined>;
  dismissProposal(taskId: string): Promise<string | undefined>;
  requestCheck(taskIds: string[]): Promise<string | undefined>;
  openCheck(sessionId: string): void;
}) {
  const { task, actions, track, head, proposal, check } = props;
  const headNumber = head?.number ?? null;
  const saved = useMemo(
    () => ticketDraft(task, head !== undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.id, task.title, task.brief, task.jira_url, head !== undefined],
  );
  const [draft, setDraft] = useState<TicketDraft>(saved);
  const [baseVersion, setBaseVersion] = useState(headNumber);
  const [briefBaseline, setBriefBaseline] = useState(saved.brief);
  const [briefTouched, setBriefTouched] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | "move" | "sprint" | "proposal" | "tracking">();
  const [syncOpen, setSyncOpen] = useState(false);
  /// A sprint chosen for a Jira-decided Task, waiting for confirmation.
  const [jiraMove, setJiraMove] = useState<{ sprintId: string | null }>();
  const [message, setMessage] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const savedTracking = useMemo(
    () => trackingDraft(props.tracking),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.tracking?.updatedAtEpochMs],
  );
  const [ownFields, setOwnFields] = useState<TrackingDraft>(savedTracking);
  useEffect(() => { setOwnFields(savedTracking); }, [savedTracking]);
  const reloadNext = useRef(false);

  const briefDirty = briefTouched && draft.brief.trim() !== briefBaseline.trim();
  const titleDirty = !sameTicket({ ...draft, brief: saved.brief }, saved);
  const dirty = briefDirty || titleDirty;
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
  const settled = (action: () => Promise<string | undefined>) => {
    reloadNext.current = true;
    return action().then((failure) => {
      if (failure) reloadNext.current = false;
      return failure;
    });
  };
  const restore = (number: number) => settled(() => props.restoreTicket(task.id, number, headNumber));
  const tracked = (patch: Partial<ProjectManagerTaskTrackingSetParams>): ProjectManagerTaskTrackingSetParams => ({
    taskId: task.id,
    sprintId: props.tracking?.sprintId ?? null,
    developer: props.tracking?.developer ?? null,
    blockers: props.tracking?.blockers ?? null,
    note: props.tracking?.note ?? null,
    ...patch,
  });
  const commitOwnFields = () => {
    const text = (value: string) => value.trim() || null;
    const next = { developer: text(ownFields.developer), blockers: text(ownFields.blockers), note: text(ownFields.note) };
    const previous = { developer: text(savedTracking.developer), blockers: text(savedTracking.blockers), note: text(savedTracking.note) };
    if (JSON.stringify(next) === JSON.stringify(previous) || props.disabled) return;
    void run("tracking", () => props.setTracking(tracked(next)));
  };
  const own = (patch: Partial<TrackingDraft>) => setOwnFields((current) => ({ ...current, ...patch }));
  const update = (patch: Partial<TicketDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const jiraKey = jiraIssueKey(task.jira_url);
  const developer = taskDeveloper(task, props.tracking, props.facts);
  // One list of blockers: the Project Manager's entry wins, and the
  // delivery check's shows only while they have written none.
  const checkNotes = props.facts?.checkNotes;
  const checkedBlockers = !ownFields.blockers.trim() && checkNotes?.blockers?.trim() ? checkNotes : null;
  const currentIndex = track.findIndex((step) => step.state === "current");
  const current = currentIndex >= 0 ? track[currentIndex] : undefined;
  const next = currentIndex >= 0 ? track[currentIndex + 1] : undefined;
  const passed = track.filter((step) => step.state === "passed").length;
  const done = track.length > 0 && passed === track.length;
  const sprintId = props.tracking?.sprintId ?? "";
  const open = task.status === "open";
  /// When the sprints mirror Jira, Jira decides a Jira-linked Task's sprint,
  /// and choosing one moves the issue in Jira after a confirmation.
  const sprintFromJira = props.sprintsFromJira && Boolean(task.jira_url);
  const selectableSprints = props.sprints.filter((sprint) =>
    sprint.id === sprintId || (sprint.state !== "closed" && (!sprintFromJira || sprint.jira !== null)));
  const jiraMoveTarget = jiraMove ? props.sprints.find((sprint) => sprint.id === jiraMove.sprintId)?.name ?? "the backlog" : undefined;

  return <div className={`task-detail pm-ticket${historyOpen ? " with-history" : ""}`}>
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
            title={sprintFromJira ? "Jira keeps this Task's sprint; choosing one moves the issue in Jira" : undefined}
            onChange={(event) => {
              const next = event.target.value || null;
              if (sprintFromJira) setJiraMove(next === (props.tracking?.sprintId ?? null) ? undefined : { sprintId: next });
              else void run("sprint", () => props.setTracking(tracked({ sprintId: next })));
            }}
          >
            <option value="">Backlog</option>
            {selectableSprints.map((sprint) => <option key={sprint.id} value={sprint.id}>
              {sprint.name}{sprint.state === "active" ? " · active" : sprint.state === "closed" ? " · closed" : ""}
            </option>)}
          </select>
        </label>
        {task.status === "closed" ? <span className="td-status closed">Closed</span> : null}
        {track.length > 0 ? <span className={`pm-meta-step${done ? " done" : ""}`} title={`${passed} of ${track.length} stages passed`}>
          <i aria-hidden="true" />{done ? "Done" : current ? [current.title, current.detail].filter(Boolean).join(" · ") : track[0]!.title}
        </span> : null}
        {check ? <button
          type="button"
          className="pm-meta-check"
          title="Open the delivery check's terminal"
          onClick={() => props.openCheck(check.sessionId)}
        ><span className="pm-agent-dot working" aria-hidden="true" />Checking<Icon name="terminal" /></button> : null}
      </div>
      <div className="pm-doc-bar-actions">
        {task.jira_url && jiraKey ? <button
          type="button"
          className="td-mini"
          disabled={props.disabled}
          title="Compare the ticket with the Jira issue, then update either one"
          onClick={() => setSyncOpen(true)}
        ><Icon name="upload" />Sync with Jira</button> : null}
        {open && !check ? <button
          type="button"
          className="td-mini"
          disabled={props.disabled || busy !== undefined}
          title="Start a short-lived Agent that looks at deployments and the ticket, records what it finds, and proposes ticket changes"
          onClick={() => void run("check", () => props.requestCheck([task.id]))}
        ><Icon name="restart" />{busy === "check" ? "Starting…" : "Check now"}</button> : null}
        <button
          type="button"
          className={`pm-version-badge${historyOpen ? " open" : ""}`}
          aria-pressed={historyOpen}
          title="Show the ticket's versions"
          onClick={() => setHistoryOpen((value) => !value)}
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
              v{headNumber} was saved while you were editing.
              {conflict ? " Saving yours would replace it." : ""}
            </span>
            <button type="button" className="td-mini" onClick={() => setHistoryOpen(true)}>See changes</button>
            <button type="button" className="td-mini" onClick={load}>Load v{headNumber}</button>
            {conflict ? <button type="button" className="td-mini danger" disabled={busy !== undefined} onClick={() => void save(true)}>Save mine anyway</button> : null}
          </div> : null}
          {message ? <div className="pm-banner danger" role="alert"><span>{message}</span></div> : null}
          {jiraMove ? <div className="pm-banner warning" role="status" aria-label="Move in Jira">
            <Icon name="alert" />
            <span>Move {jiraKey} to {jiraMoveTarget} in Jira? Everyone working from the Jira board sees the move.</span>
            <button type="button" className="td-mini danger" disabled={props.disabled || busy !== undefined}
              onClick={() => void run("sprint", () => props.moveJiraSprint(task.id, jiraMove.sprintId)).then((failure) => { if (!failure) setJiraMove(undefined); })}>
              {busy === "sprint" ? "Moving…" : "Move in Jira"}
            </button>
            <button type="button" className="td-mini" disabled={busy !== undefined} onClick={() => setJiraMove(undefined)}>Cancel</button>
          </div> : null}
          {props.risks.length > 0 && open ? <ul className="pm-risks" aria-label="Risks">
            {props.risks.map((risk, index) => <li key={index} className={`pm-risk ${risk.kind}`}>
              <Icon name="alert" /><b>{RISK_LABELS[risk.kind]}</b><span>{risk.detail}</span>
            </li>)}
          </ul> : null}
          {proposal ? <div className="pm-banner proposal" role="status" aria-label="Proposed ticket update">
            <Icon name="sparkles" />
            <span>A delivery check proposes: <strong>{proposal.summary}</strong> · {relativeTime(proposal.proposedAtEpochMs)}</span>
            <button type="button" className="td-mini" aria-expanded={proposalOpen} onClick={() => setProposalOpen((value) => !value)}>
              {proposalOpen ? "Hide" : "Review"}
            </button>
            <button
              type="button"
              className="td-mini"
              disabled={props.disabled || busy !== undefined || dirty}
              title={dirty ? "Save or discard your edits first" : "Save the proposal as the ticket's next version"}
              onClick={() => void run("proposal", () => settled(() => props.acceptProposal(task.id, headNumber)))}
            >Accept</button>
            <button type="button" className="td-mini" disabled={props.disabled || busy !== undefined}
              onClick={() => void run("proposal", () => props.dismissProposal(task.id))}>Dismiss</button>
            {proposalOpen ? <div className="pm-proposal">
              {proposal.baseVersion !== headNumber ? <p className="td-note">Proposed against v{proposal.baseVersion}; the ticket is now v{headNumber ?? 0}.</p> : null}
              {proposal.title ? <p><strong>Title:</strong> {proposal.title}</p> : null}
              {proposal.brief ? <pre className="pm-proposal-brief">{proposal.brief}</pre> : null}
            </div> : null}
          </div> : null}
          {!props.inActiveSprint && open ? <div className="pm-banner">
            <span>
              TermLoop reads Jira and pull requests only for Tasks in the active sprint{props.activeSprint ? ` (${props.activeSprint.name})` : ""}.
            </span>
            {props.activeSprint && !sprintFromJira ? <button type="button" className="td-mini" disabled={props.disabled || busy !== undefined}
              onClick={() => void run("move", () => props.setTracking(tracked({ sprintId: props.activeSprint!.id })))}>
              {busy === "move" ? "Moving…" : `Move to ${props.activeSprint.name}`}
            </button> : null}
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
              {developer.fromJira
                ? <dd className="pm-fact">{developer.name ?? <span className="pm-dim">Unassigned</span>}<span className="pm-fact-source">From Jira</span></dd>
                : <dd><input aria-label="Developer" value={ownFields.developer} placeholder="Empty" maxLength={120} disabled={props.disabled}
                  onChange={(event) => own({ developer: event.target.value })}
                  onBlur={commitOwnFields} /></dd>}
            </div>
            {track.length > 0 ? <div className="pm-prop">
              <dt><Icon name="branch" />Delivery</dt>
              <dd className="pm-delivery">
                <div className="pm-progress" aria-hidden="true">
                  {track.map((step) => <i key={step.id} className={step.state} title={step.title} />)}
                </div>
                <span className="pm-delivery-now">{done ? "Done" : current?.title ?? track[0]!.title}</span>
                {current?.detail ? <span className="pm-evidence">{current.detail}</span> : null}
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
            {task.jira_url ? <p className="td-note">Saved versions stay in TermLoop until you send one with Sync with Jira.</p> : null}
          </section>

          <ProjectManagerDeliveryFacts
            facts={props.facts}
            disabled={props.disabled}
            openExternal={actions.openExternal}
            setEnvironment={(command) => props.setEnvironment({ taskId: task.id, ...command })}
          />
          <div className="pm-doc-pair">
            <ProjectManagerTicketText label="Blockers" tone="warning" value={ownFields.blockers} placeholder="What stops delivery right now" disabled={props.disabled}
              hint={checkedBlockers ? <p className="pm-fact-blockers"><Icon name="alert" />
                <span>{checkedBlockers.blockers}</span>
                <span className="pm-fact-source">Reported by a delivery check {relativeTime(checkedBlockers.recordedAtEpochMs)}; what you write here replaces it</span>
              </p> : null}
              change={(blockers) => own({ blockers })} commit={commitOwnFields} />
            <ProjectManagerTicketText label="Note" value={ownFields.note} placeholder="Your own note; no Agent changes it" disabled={props.disabled}
              change={(note) => own({ note })} commit={commitOwnFields} />
          </div>
        </article>
      </div>
      {syncOpen && jiraKey ? <ProjectManagerJiraSync
        taskId={task.id}
        issueKey={jiraKey}
        version={headNumber}
        ticket={saved}
        dirty={dirty}
        disabled={props.disabled}
        read={actions.readJiraIssue}
        push={actions.pushJiraIssue}
        pull={(ticket) => settled(() => props.saveTicket(ticketSaveParams(task.id, ticket, "Pulled from Jira", headNumber)))}
        close={() => setSyncOpen(false)}
      /> : null}
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
  </div>;
}
