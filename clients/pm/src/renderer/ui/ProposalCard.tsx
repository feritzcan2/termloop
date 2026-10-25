import { useState } from "react";
import type { PmProposal } from "@termloop/pm-contract/pm";
import { relativeTime } from "./format.js";

export type ProposalCardProps = {
  proposal: PmProposal;
  /** The ticket's current description, or its criteria joined by newline. */
  current: string;
  /** The description version the agent drafted against. */
  headVersion: number;
  now: number;
  onAccept(): void;
  onReject(): void;
};

/** An assistant draft. Nothing changes until the PM applies it. */
export function ProposalCard(props: ProposalCardProps) {
  const [showDiff, setShowDiff] = useState(true);
  const change = props.proposal.change;
  const proposed = change.kind === "description" ? change.description : change.criteria.join("\n");
  const outdated = change.kind === "description" && props.proposal.baseVersion !== props.headVersion;
  return (
    <section className="draft-card" aria-label="Agent proposal">
      <div className="draft-head">
        <span className="sec-label">Assistant draft</span>
        <span className="meta">{change.kind === "description" ? "description" : "acceptance criteria"} · {relativeTime(props.proposal.createdAtEpochMs, props.now)}</span>
        <span className="sp" />
        <button type="button" className="btn sm ghost" onClick={() => setShowDiff(!showDiff)}>{showDiff ? "Hide changes" : "Show changes"}</button>
        <button type="button" className="btn sm" onClick={props.onReject}>Dismiss</button>
        <button type="button" className="btn sm pri" onClick={props.onAccept}>{change.kind === "description" ? `Apply as v${props.headVersion + 1}` : "Apply"}</button>
      </div>
      {props.proposal.summary && <p className="draft-summary">{props.proposal.summary}</p>}
      {outdated && <p className="hint">Drafted against version {props.proposal.baseVersion}; the description has changed since.</p>}
      {showDiff && (
        <div className="draft-diff">
          {lineDiff(props.current, proposed).map((line, index) => (
            <div key={index} className={`diff-line ${line.kind}`}>{line.text || "\u00a0"}</div>
          ))}
        </div>
      )}
    </section>
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
