import { useEffect, useState } from "react";
import type { PmBoardTicket, PmDataTier, PmProposal, PmSprint, PmTicketVersion } from "@termloop/pm-contract/pm";
import { MarkdownEditor } from "./MarkdownEditor.js";
import { ProposalCard } from "./ProposalCard.js";
import { TicketFields } from "./TicketFields.js";
import { AUTHOR_LABEL, VersionsList } from "./VersionsList.js";
import { RISK_LABEL, jiraKey, relativeTime, riskTone, ticketLabel } from "./format.js";
import { ticketScope } from "./scope.js";
import { descriptionEdited, isSaveShortcut, titleUpdate, type DescriptionDraft, type TicketFieldUpdate } from "./ticket-edit.js";
import type { DescriptionSaveOutcome } from "./types.js";

export type TicketEditorProps = {
  entry: PmBoardTicket;
  sprints: PmSprint[];
  tier: PmDataTier;
  jiraConfigured: boolean;
  deployTracking: boolean;
  proposals: PmProposal[];
  versions: PmTicketVersion[] | undefined;
  now: number;
  onUpdate(fields: TicketFieldUpdate): void;
  onMoveSprint(sprintId: string | null): void;
  onSaveDescription(description: string, baseVersion: number): Promise<DescriptionSaveOutcome>;
  onLoadVersions(): void;
  onAddCriterion(text: string): void;
  onSetCriterionDone(criterionId: string, done: boolean): void;
  onRemoveCriterion(criterionId: string): void;
  onAddBlocker(text: string): void;
  onRemoveBlocker(blockerId: string): void;
  onAcceptProposal(proposalId: string): void;
  onRejectProposal(proposalId: string): void;
  onOpenLink(url: string): void;
  onWriteToJira(): void;
  onStartCheck(): void;
  onAskAgent(): void;
};

/** What the Markdown editor loads; `asEdit` marks a loaded older version, which counts as an edit. */
type EditorSource = { text: string; key: number; asEdit: boolean };

const PLACEHOLDER = "Describe the goal, scope, and links. Type # for a heading, - for a list, [ ] for a checklist.";

/** One ticket's editor; the composition keys it by ticket so another ticket always loads fresh. */
export function TicketEditor(props: TicketEditorProps) {
  const { ticket, delivery } = props.entry;
  const head = ticket.versions;
  const headVersion = head?.headNumber ?? 0;
  const [title, setTitle] = useState(ticket.title);
  const [source, setSource] = useState<EditorSource>({ text: ticket.description, key: 0, asEdit: false });
  const [draft, setDraft] = useState<DescriptionDraft>({ text: ticket.description, baseline: ticket.description, touched: false });
  // The version the edit started from; the daemon refuses a save on an older one.
  const [base, setBase] = useState(headVersion);
  const [conflict, setConflict] = useState(false);
  const [criterion, setCriterion] = useState("");
  const [blocker, setBlocker] = useState("");
  const [saving, setSaving] = useState(false);
  const dirty = descriptionEdited(draft);
  const newerSaved = headVersion !== base;
  const { onLoadVersions } = props;

  /** Replaces the editor with the newest saved description. */
  const load = () => {
    setSource((current) => ({ text: ticket.description, key: current.key + 1, asEdit: false }));
    setDraft({ text: ticket.description, baseline: ticket.description, touched: false });
    setBase(headVersion);
    setConflict(false);
  };
  useEffect(() => setTitle(ticket.title), [ticket.title]);
  // A newer saved description replaces the editor unless the PM is mid-edit;
  // an edit in progress keeps its base so a stale save is refused.
  useEffect(() => {
    if (headVersion !== base && !dirty) load();
  }, [headVersion]);
  // The versions list is always on screen; reread it per head.
  useEffect(() => onLoadVersions(), [headVersion]);

  const save = async (overwrite = false) => {
    if (!dirty || saving) return;
    setSaving(true);
    const text = draft.text;
    try {
      const outcome = await props.onSaveDescription(text, overwrite ? headVersion : base);
      if (outcome.kind === "saved") {
        // What was saved is now the baseline; the editor keeps its content and cursor.
        setDraft((current) => ({ ...current, baseline: text, touched: current.text !== text }));
        setBase(outcome.headVersion);
        setConflict(false);
      } else if (outcome.kind === "conflict") {
        setConflict(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const key = jiraKey(ticket);
  const scope = ticketScope(ticket, props.sprints, props.versions);
  const doneCount = ticket.acceptanceCriteria.filter((item) => item.done).length;

  return (
    <section
      className="pane ticket-pane"
      aria-label="Ticket"
      onKeyDown={(event) => {
        if (isSaveShortcut(event)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div className="pane-head">
        <span className="k">{ticketLabel(ticket)}</span>
        <input
          className="title-input"
          aria-label="Title"
          value={title}
          maxLength={160}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => { const update = titleUpdate(title, ticket); if (update) props.onUpdate(update); }}
        />
        {head && <span className="meta">v{head.headNumber} · {AUTHOR_LABEL[head.headAuthor]} · {relativeTime(head.headRecordedAtEpochMs, props.now)}</span>}
        <span className="sp" />
        {ticket.jiraUrl && <button type="button" className="link" onClick={() => props.onOpenLink(ticket.jiraUrl!)}>Open in Jira</button>}
        {key && props.jiraConfigured && <button type="button" className="btn sm" onClick={props.onWriteToJira}>Write to Jira…</button>}
      </div>
      <div className="body">
        <TicketFields
          ticket={ticket}
          delivery={delivery}
          sprints={props.sprints}
          tier={props.tier}
          now={props.now}
          onUpdate={props.onUpdate}
          onMoveSprint={props.onMoveSprint}
          actions={<>
            <button type="button" className="btn sm ghost" onClick={props.onAskAgent}>Ask assistant</button>
            {props.deployTracking && <button type="button" className="btn sm ghost" disabled={delivery.checking} onClick={props.onStartCheck}>{delivery.checking ? "Checking…" : "Check delivery"}</button>}
          </>}
        />
        {(delivery.risks.length > 0 || scope) && (
          <ul className="risk-list">
            {delivery.risks.map((risk, index) => <li key={index} className={riskTone(risk.kind)}><strong>{RISK_LABEL[risk.kind]}</strong> {risk.detail}</li>)}
            {scope && <li className="warn" data-testid="scope-grew"><strong>Scope grew</strong> {scope.explanation}.</li>}
          </ul>
        )}

        <h3 className="s">Description <span className="r">⌘S saves as v{headVersion + 1}</span></h3>
        {(conflict || (dirty && newerSaved)) && (
          <div className="banner warn" role="status">
            <span>v{headVersion} was saved while you were editing.{conflict ? " Saving yours would replace it." : ""}</span>
            <span className="sp" />
            <button type="button" className="btn sm ghost" onClick={load}>Load v{headVersion}</button>
            {conflict && <button type="button" className="btn sm" disabled={saving} onClick={() => void save(true)}>Save mine anyway</button>}
          </div>
        )}
        <MarkdownEditor
          value={source.text}
          resetKey={String(source.key)}
          label="Description"
          placeholder={PLACEHOLDER}
          onBaseline={(markdown) => setDraft((current) => source.asEdit
            ? { ...current, text: markdown, touched: true }
            : { text: markdown, baseline: markdown, touched: false })}
          onChange={(markdown) => setDraft((current) => ({ ...current, text: markdown, touched: true }))}
        />
        {dirty && (
          <div className="description-foot">
            <span className="hint">Unsaved changes</span>
            <span className="sp" />
            <button type="button" className="btn sm ghost" disabled={saving} onClick={load}>Discard</button>
            <button type="button" className="btn sm pri" title="Save (⌘S / Ctrl+S)" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : `Save as v${headVersion + 1}`}</button>
          </div>
        )}

        {props.proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            current={proposal.change.kind === "description" ? ticket.description : ticket.acceptanceCriteria.map((item) => item.text).join("\n")}
            headVersion={headVersion}
            now={props.now}
            onAccept={() => props.onAcceptProposal(proposal.id)}
            onReject={() => props.onRejectProposal(proposal.id)}
          />
        ))}

        <h3 className="s">Acceptance criteria <small>{doneCount} of {ticket.acceptanceCriteria.length} met</small></h3>
        <ul className="checklist">
          {ticket.acceptanceCriteria.map((item) => (
            <li key={item.id} className={item.done ? "done" : ""}>
              <label>
                <input type="checkbox" checked={item.done} onChange={(event) => props.onSetCriterionDone(item.id, event.target.checked)} />
                <span>{item.text}</span>
              </label>
              <button type="button" className="icb remove" aria-label="Remove criterion" onClick={() => props.onRemoveCriterion(item.id)}>×</button>
            </li>
          ))}
        </ul>
        <form className="add-line" onSubmit={(event) => { event.preventDefault(); if (criterion.trim()) props.onAddCriterion(criterion); setCriterion(""); }}>
          <input placeholder="+ Add a criterion" aria-label="New criterion" value={criterion} onChange={(event) => setCriterion(event.target.value)} />
        </form>

        <h3 className="s">Blockers <small>{ticket.blockers.length} open</small></h3>
        <ul className="blockers">
          {ticket.blockers.map((item) => (
            <li key={item.id}>
              <span className="blocker-dot" />
              <span>{item.text}</span>
              <button type="button" className="icb remove" aria-label="Remove blocker" onClick={() => props.onRemoveBlocker(item.id)}>×</button>
            </li>
          ))}
        </ul>
        <form className="add-line" onSubmit={(event) => { event.preventDefault(); if (blocker.trim()) props.onAddBlocker(blocker); setBlocker(""); }}>
          <input placeholder="+ Add a blocker" aria-label="Add blocker" value={blocker} onChange={(event) => setBlocker(event.target.value)} />
        </form>

        <h3 className="s">Versions <small>{head?.count ?? 0}</small></h3>
        <VersionsList
          versions={props.versions}
          headVersion={headVersion}
          now={props.now}
          onRestore={(text) => setSource((current) => ({ text, key: current.key + 1, asEdit: true }))}
        />
      </div>
    </section>
  );
}
