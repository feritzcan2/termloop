import { useState } from "react";
import type { PmEvidence, PmProposal, PmProposalChange, PmTicket } from "@termloop/pm-contract/pm";
import { STATUS_LABEL, relativeTime } from "./format.js";
import { proposalKindLabel, textChange, touchesJira } from "./proposal-change.js";

export type ProposalCardProps = {
  proposal: PmProposal;
  ticket: PmTicket;
  /** The description version the agent drafted against. */
  headVersion: number;
  now: number;
  /** The name of the skill that made it; the inbox tags each suggestion with it. */
  source?: string;
  /** A sprint's name for a sprint move; the backlog for `null`. */
  sprintName(sprintId: string | null): string;
  /** `assignee` is the shortlisted person the PM picked. */
  onAccept(assignee?: string): void;
  onReject(): void;
  onOpenLink(url: string): void;
};

/** An agent or skill draft. Nothing changes until the PM applies it. */
export function ProposalCard(props: ProposalCardProps) {
  const [showDiff, setShowDiff] = useState(true);
  const { proposal, ticket } = props;
  const change = proposal.change;
  const text = textChange(change, ticket);
  const outdated = change.kind === "description" && proposal.baseVersion !== props.headVersion;
  const shortlist = change.kind === "assignee" ? change.shortlist : [];
  return (
    <section className="draft-card" aria-label="Agent proposal">
      <div className="draft-head">
        <span className="sec-label">{proposal.skillId ? (props.source ?? "Skill suggestion") : "Assistant draft"}</span>
        <span className="meta">{proposalKindLabel(change)} · {relativeTime(proposal.createdAtEpochMs, props.now)}</span>
        <span className="sp" />
        {text && <button type="button" className="btn sm ghost" onClick={() => setShowDiff(!showDiff)}>{showDiff ? "Hide changes" : "Show changes"}</button>}
        <button type="button" className="btn sm" onClick={props.onReject}>Dismiss</button>
        <button type="button" className="btn sm pri" onClick={() => props.onAccept()}>{change.kind === "description" ? `Apply as v${props.headVersion + 1}` : "Apply"}</button>
      </div>
      {proposal.summary && <p className="draft-summary">{proposal.summary}</p>}
      {outdated && <p className="hint">Drafted against version {proposal.baseVersion}; the description has changed since.</p>}
      {text && showDiff && (
        <div className="draft-diff">
          {lineDiff(text.current, text.proposed).map((line, index) => (
            <div key={index} className={`diff-line ${line.kind}`}>{line.text || "\u00a0"}</div>
          ))}
        </div>
      )}
      {!text && <p className="draft-change">{changeLine(change, ticket, props.sprintName)}</p>}
      {shortlist.length > 0 && (
        <ol className="shortlist" aria-label="Shortlist">
          {shortlist.map((candidate) => (
            <li key={candidate.name}>
              <b>{candidate.name}</b> <span className="hint">{candidate.reason}</span>
              <EvidenceList evidence={candidate.evidence} onOpenLink={props.onOpenLink} />
              <button type="button" className="btn sm" onClick={() => props.onAccept(candidate.name)}>Assign {candidate.name}</button>
            </li>
          ))}
        </ol>
      )}
      <EvidenceList evidence={proposal.evidence} onOpenLink={props.onOpenLink} />
      {touchesJira(change) && ticket.jiraUrl && <p className="hint">Applying changes the ticket here; Jira changes only from “Write to Jira…”.</p>}
    </section>
  );
}

function changeLine(change: PmProposalChange, ticket: PmTicket, sprintName: (sprintId: string | null) => string): string {
  switch (change.kind) {
    case "status":
      return `Status: ${STATUS_LABEL[ticket.status]} → ${STATUS_LABEL[change.status]}`;
    case "assignee":
      return `Assignee: ${ticket.assignee ?? "nobody"} → ${change.assignee}`;
    case "sprint":
      return `Sprint: ${sprintName(ticket.sprintId)} → ${sprintName(change.sprintId)}`;
    case "jiraComment":
      return change.body;
    default:
      return "";
  }
}

/** Where a suggestion came from: a label, a link opened outside the app, and a short quote. */
export function EvidenceList({ evidence, onOpenLink }: { evidence: PmEvidence[]; onOpenLink(url: string): void }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="evidence" aria-label="Evidence">
      {evidence.map((item, index) => (
        <li key={index}>
          {item.url ? <button type="button" className="link" onClick={() => onOpenLink(item.url!)}>{item.label}</button> : <span>{item.label}</span>}
          {item.quote && <q>{item.quote}</q>}
        </li>
      ))}
    </ul>
  );
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

const MAX_DIFF_LINES = 600;

/** A line diff by longest common subsequence, bounded for large texts. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
    return [...left.map((text) => ({ kind: "removed" as const, text })), ...right.map((text) => ({ kind: "added" as const, text }))];
  }
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ kind: "same", text: left[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: "removed", text: left[i]! });
      i += 1;
    } else {
      lines.push({ kind: "added", text: right[j]! });
      j += 1;
    }
  }
  while (i < left.length) lines.push({ kind: "removed", text: left[i++]! });
  while (j < right.length) lines.push({ kind: "added", text: right[j++]! });
  return lines;
}
