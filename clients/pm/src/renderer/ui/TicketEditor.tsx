import { useEffect, useState } from "react";
import type {
  PmBoardTicket,
  PmDataTier,
  PmProposal,
  PmTicketAuthor,
  PmTicketPriority,
  PmTicketStatus,
  PmTicketUpdateParams,
  PmTicketVersion,
} from "@termloop/pm-contract/pm";
import { ProposalCard } from "./ProposalCard.js";
import { VersionsList } from "./VersionsList.js";
import {
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  RISK_LABEL,
  STAGE_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  jiraKey,
  relativeTime,
  riskTone,
  ticketLabel,
  tierAtLeast,
} from "./format.js";

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

export const AUTHOR_SHORT: Record<PmTicketAuthor, string> = { pm: "you", agent: "assistant", jira: "jira" };

export function TicketEditor(props: TicketEditorProps) {
  const { ticket, delivery } = props.entry;
  const headVersion = ticket.versions?.headNumber ?? 0;
  const [title, setTitle] = useState(ticket.title);
  const [assignee, setAssignee] = useState(ticket.assignee ?? "");
  const [draft, setDraft] = useState(ticket.description);
  const [draftBase, setDraftBase] = useState(headVersion);
  const [criterion, setCriterion] = useState("");
  const [blocker, setBlocker] = useState("");
  const [saving, setSaving] = useState(false);
  const dirty = draft !== ticket.description;
  const { onLoadVersions } = props;

  useEffect(() => {
    setTitle(ticket.title);
    setAssignee(ticket.assignee ?? "");
  }, [ticket.id, ticket.title, ticket.assignee]);
  useEffect(() => {
    // Another ticket always loads fresh.
    setDraft(ticket.description);
    setDraftBase(headVersion);
  }, [ticket.id]);
  useEffect(() => {
    // Adopt a newer saved description unless the PM is mid-edit on it; an
    // edit in progress keeps its base so the daemon can refuse a stale save.
    if (!dirty) {
      setDraft(ticket.description);
      setDraftBase(headVersion);
    }
  }, [headVersion]);
  useEffect(() => {
    // The versions list is always on screen; reread it per ticket and head.
    onLoadVersions();
  }, [ticket.id, headVersion]);

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
  const head = ticket.versions;

  return (
    <section className="pane ticket-pane" aria-label="Ticket">
      <div className="pane-head">
        <span className="k">{ticketLabel(ticket)}</span>
        <input
          className="title-input"
          aria-label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => { if (title.trim() && title.trim() !== ticket.title) props.onUpdate({ title: title.trim() }); }}
        />
        {head && <span className="meta">v{head.headNumber} · {AUTHOR_SHORT[head.headAuthor]} · {relativeTime(head.headRecordedAtEpochMs, props.now)}</span>}
        <span className="sp" />
        {ticket.jiraUrl && <button type="button" className="link" onClick={() => props.onOpenLink(ticket.jiraUrl!)}>Open in Jira</button>}
        {key && props.jiraConfigured && <button type="button" className="btn sm" onClick={props.onWriteToJira}>Write to Jira…</button>}
      </div>
      <div className="body">
        <div className="chips">
          <label className={`chip-control status-${ticket.status}`}>
            <i className="swatch" />
            <select aria-label="Status" value={ticket.status} onChange={(event) => props.onUpdate({ status: event.target.value as PmTicketStatus })}>
              {STATUS_ORDER.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
            </select>
          </label>
          <label className="chip-control">
            <input
              aria-label="Assignee"
              className="chip-input"
              value={assignee}
              placeholder="Unassigned"
              size={Math.max(8, assignee.length + 1)}
              onChange={(event) => setAssignee(event.target.value)}
              onBlur={() => {
                const next = assignee.trim() === "" ? null : assignee.trim();
                if (next !== ticket.assignee) props.onUpdate({ assignee: next });
              }}
            />
          </label>
          <label className="chip-control">
            <select aria-label="Priority" value={ticket.priority} onChange={(event) => props.onUpdate({ priority: event.target.value as PmTicketPriority })}>
              {PRIORITY_ORDER.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}
            </select>
          </label>
          <span className="chip-static">{props.sprintName ?? "No sprint"}</span>
          {ticket.blockers.length > 0 && <span className="chip-static bad">Blocked · {ticket.blockers[0]!.text}{ticket.blockers.length > 1 ? ` +${ticket.blockers.length - 1}` : ""}</span>}
          {showCode && <span className="chip-static">{STAGE_LABEL[delivery.stage.kind]}{delivery.stage.environment ? ` · ${delivery.stage.environment}` : ""}</span>}
          {showCode && delivery.facts && <span className="chip-static">PR × {delivery.facts.pullRequests}</span>}
          <span className="sp" />
          <button type="button" className="btn sm ghost" onClick={props.onAskAgent}>Ask assistant</button>
          {props.deployTracking && <button type="button" className="btn sm ghost" disabled={delivery.checking} onClick={props.onStartCheck}>{delivery.checking ? "Checking…" : "Check delivery"}</button>}
        </div>
        {delivery.risks.length > 0 && (
          <ul className="risk-list">
            {delivery.risks.map((risk, index) => <li key={index} className={riskTone(risk.kind)}><strong>{RISK_LABEL[risk.kind]}</strong> {risk.detail}</li>)}
          </ul>
        )}

        <h3 className="s">Description <span className="r">⌘S saves as v{headVersion + 1}</span></h3>
        <textarea
          className="description"
          aria-label="Description"
          value={draft}
          rows={8}
          placeholder="Describe the ticket…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void saveDescription();
            }
          }}
        />
        {dirty && (
          <div className="description-foot">
            {draftBase !== headVersion && <span className="hint">Saved meanwhile as v{headVersion}; saving will be refused until you reload it.</span>}
            <span className="sp" />
            <button type="button" className="btn sm ghost" onClick={() => { setDraft(ticket.description); setDraftBase(headVersion); }}>Discard</button>
            <button type="button" className="btn sm pri" title="Save (⌘S / Ctrl+S)" disabled={saving} onClick={() => void saveDescription()}>Save</button>
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

        <h3 className="s">Versions <small>{ticket.versions?.count ?? 0}</small></h3>
        <VersionsList versions={props.versions} now={props.now} onRestore={setDraft} />
      </div>
    </section>
  );
}
