import { useEffect, useState } from "react";
import type {
  PmBoardTicket,
  PmDataTier,
  PmProposal,
  PmTicketStatus,
  PmTicketUpdateParams,
  PmTicketVersion,
} from "@termloop/pm-contract/pm";
import { ProposalCard } from "./ProposalCard.js";
import { VersionsList } from "./VersionsList.js";
import { RISK_LABEL, STAGE_LABEL, STATUS_LABEL, STATUS_ORDER, jiraKey, ticketLabel, tierAtLeast } from "./format.js";

export type TicketEditorProps = {
  entry: PmBoardTicket;
  sprintName: string | undefined;
  tier: PmDataTier;
  jiraConfigured: boolean;
  deployTracking: boolean;
  proposals: PmProposal[];
  versions: PmTicketVersion[] | undefined;
  now: number;
  onUpdate(fields: Omit<PmTicketUpdateParams, "ticketId">): void;
  onSaveDescription(description: string, baseVersion: number): Promise<boolean>;
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

export function TicketEditor(props: TicketEditorProps) {
  const { ticket, delivery } = props.entry;
  const headVersion = ticket.versions?.headNumber ?? 0;
  const [title, setTitle] = useState(ticket.title);
  const [assignee, setAssignee] = useState(ticket.assignee ?? "");
  const [draft, setDraft] = useState(ticket.description);
  const [draftBase, setDraftBase] = useState(headVersion);
  const [showVersions, setShowVersions] = useState(false);
  const [criterion, setCriterion] = useState("");
  const [blocker, setBlocker] = useState("");
  const [saving, setSaving] = useState(false);
  const dirty = draft !== ticket.description;

  useEffect(() => {
    setTitle(ticket.title);
    setAssignee(ticket.assignee ?? "");
  }, [ticket.id, ticket.title, ticket.assignee]);
  useEffect(() => {
    // Another ticket always loads fresh.
    setDraft(ticket.description);
    setDraftBase(headVersion);
    setShowVersions(false);
  }, [ticket.id]);
  useEffect(() => {
    // Adopt a newer saved description unless the PM is mid-edit on it; an
    // edit in progress keeps its base so the daemon can refuse a stale save.
    if (!dirty) {
      setDraft(ticket.description);
      setDraftBase(headVersion);
    }
  }, [headVersion]);

  const key = jiraKey(ticket);
  const showCode = tierAtLeast(props.tier, "code");
  const doneCount = ticket.acceptanceCriteria.filter((item) => item.done).length;
  const saveDescription = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await props.onSaveDescription(draft, draftBase);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="pm-ticket-editor" aria-label="Ticket">
      <div className="pm-ticket-crumbs">
        <span className="pm-mono">{ticketLabel(ticket)}</span>
        {ticket.jiraUrl && (
          <button type="button" className="pm-link" onClick={() => props.onOpenLink(ticket.jiraUrl!)}>Open in Jira ↗</button>
        )}
        <span className="pm-muted">· {props.sprintName ?? "No sprint"}</span>
        <label className="pm-assignee">
          <span className="pm-muted">Assignee</span>
          <input
            value={assignee}
            placeholder="Unassigned"
            onChange={(event) => setAssignee(event.target.value)}
            onBlur={() => {
              const next = assignee.trim() === "" ? null : assignee.trim();
              if (next !== ticket.assignee) props.onUpdate({ assignee: next });
            }}
          />
        </label>
      </div>
      <input
        className="pm-title-input"
        aria-label="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => { if (title.trim() && title.trim() !== ticket.title) props.onUpdate({ title: title.trim() }); }}
      />
      <div className="pm-chips">
        <select
          aria-label="Status"
          className={`pm-pill status-${ticket.status}`}
          value={ticket.status}
          onChange={(event) => props.onUpdate({ status: event.target.value as PmTicketStatus })}
        >
          {STATUS_ORDER.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
        </select>
        {showCode && <span className={`pm-pill stage stage-${delivery.stage.kind}`}>{STAGE_LABEL[delivery.stage.kind]}</span>}
        {showCode && delivery.facts && <span className="pm-pill">PR × {delivery.facts.pullRequests}</span>}
        {ticket.blockers.map((item) => (
          <span key={item.id} className="pm-pill blocker">
            Blocked: {item.text}
            <button type="button" aria-label="Remove blocker" onClick={() => props.onRemoveBlocker(item.id)}>×</button>
          </span>
        ))}
        <form className="pm-inline-form" onSubmit={(event) => { event.preventDefault(); if (blocker.trim()) props.onAddBlocker(blocker); setBlocker(""); }}>
          <input className="pm-chip-input" placeholder="+ blocker" aria-label="Add blocker" value={blocker} onChange={(event) => setBlocker(event.target.value)} />
        </form>
        <span className="pm-chip-actions">
          <button type="button" className="pm-button ghost" onClick={props.onAskAgent}>Ask agent</button>
          {props.deployTracking && <button type="button" className="pm-button ghost" disabled={delivery.checking} onClick={props.onStartCheck}>{delivery.checking ? "Checking…" : "Check delivery"}</button>}
          {key && props.jiraConfigured && <button type="button" className="pm-button" onClick={props.onWriteToJira}>Write to Jira…</button>}
        </span>
      </div>
      {delivery.risks.length > 0 && (
        <ul className="pm-risk-list">
          {delivery.risks.map((risk, index) => <li key={index}><span className="pm-risk-dot" /> <strong>{RISK_LABEL[risk.kind]}</strong> {risk.detail}</li>)}
        </ul>
      )}
      {props.proposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          current={proposal.change.kind === "description" ? ticket.description : ticket.acceptanceCriteria.map((item) => item.text).join("\n")}
          headVersion={headVersion}
          onAccept={() => props.onAcceptProposal(proposal.id)}
          onReject={() => props.onRejectProposal(proposal.id)}
        />
      ))}
      <section className="pm-card">
        <div className="pm-card-head">
          <h3>Description</h3>
          <span className="pm-muted pm-mono">v{headVersion} · {ticket.versions?.count ?? 0} versions</span>
          <button
            type="button"
            className="pm-button ghost small"
            onClick={() => { if (!showVersions) props.onLoadVersions(); setShowVersions(!showVersions); }}
          >
            Versions
          </button>
        </div>
        <textarea
          className="pm-description"
          aria-label="Description"
          value={draft}
          rows={10}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void saveDescription();
            }
          }}
        />
        <div className="pm-card-foot">
          {draftBase !== headVersion && dirty && <span className="pm-hint">Saved meanwhile as v{headVersion}; saving will be refused until you reload it.</span>}
          <button type="button" className="pm-button ghost" disabled={!dirty} onClick={() => { setDraft(ticket.description); setDraftBase(headVersion); }}>Discard</button>
          <button type="button" className="pm-button primary" title="Save (⌘S / Ctrl+S)" disabled={!dirty || saving} onClick={() => void saveDescription()}>Save</button>
        </div>
        {showVersions && <VersionsList versions={props.versions} now={props.now} onRestore={setDraft} />}
      </section>
      <section className="pm-card">
        <div className="pm-card-head">
          <h3>Acceptance criteria</h3>
          <span className="pm-muted">{doneCount}/{ticket.acceptanceCriteria.length}</span>
        </div>
        <ul className="pm-criteria">
          {ticket.acceptanceCriteria.map((item) => (
            <li key={item.id}>
              <label>
                <input type="checkbox" checked={item.done} onChange={(event) => props.onSetCriterionDone(item.id, event.target.checked)} />
                <span className={item.done ? "done" : ""}>{item.text}</span>
              </label>
              <button type="button" className="pm-icon-button" aria-label="Remove criterion" onClick={() => props.onRemoveCriterion(item.id)}>×</button>
            </li>
          ))}
        </ul>
        <form className="pm-inline-form" onSubmit={(event) => { event.preventDefault(); props.onAddCriterion(criterion); setCriterion(""); }}>
          <input placeholder="Add a criterion…" aria-label="New criterion" value={criterion} onChange={(event) => setCriterion(event.target.value)} />
          <button type="submit" className="pm-button" disabled={!criterion.trim()}>Add</button>
        </form>
      </section>
    </article>
  );
}
