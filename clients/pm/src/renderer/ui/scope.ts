// Scope creep: did a ticket's acceptance criteria grow since its sprint started?
// Pure functions of saved description versions; the structured criteria list
// has no history, so only the description's criteria section is compared.
import type { PmSprint, PmTicket } from "@termloop/pm-contract/pm";

export type ScopeVersion = { number: number; description: string; recordedAtEpochMs: number };

/** A description's acceptance-criteria section: its list items and its text length. */
export type CriteriaBlock = { items: number; chars: number };

export type ScopeGrowth = {
  from: CriteriaBlock;
  to: CriteriaBlock;
  /** `sprintStart` compares with the version saved at sprint start; `firstVersion` with the first one saved after it. */
  since: "sprintStart" | "firstVersion";
  explanation: string;
};

/** Growth that counts as material: this many more items, or this much more text. */
const MIN_ADDED_ITEMS = 2;
const MIN_TEXT_GROWTH = 0.4;

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
// A bold or colon-ended line also opens the section ("**Acceptance criteria**", "Acceptance criteria:").
const LABEL = /^\s*(\*\*|__)?\s*acceptance criteria\s*:?\s*(\*\*|__)?\s*:?\s*$/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/**
 * The acceptance-criteria section of a Markdown description: the lines after
 * a heading (or a label line) naming acceptance criteria, up to the next
 * heading. `undefined` when the description has no such section.
 */
export function criteriaBlock(markdown: string): CriteriaBlock | undefined {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = HEADING.exec(line);
    return heading ? /acceptance criteria/i.test(heading[2]!) : LABEL.test(line);
  });
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    body.push(line);
  }
  return {
    items: body.filter((line) => LIST_ITEM.test(line)).length,
    chars: body.join(" ").replace(/\s+/g, " ").trim().length,
  };
}

const NONE: CriteriaBlock = { items: 0, chars: 0 };

/**
 * Compares the newest saved version's criteria with those of the version that
 * was current at `sprintStartMs`, or with the first version when every version
 * is newer (the ticket was written after the sprint started). Material growth
 * is {@link MIN_ADDED_ITEMS} more items or {@link MIN_TEXT_GROWTH} more text.
 */
export function scopeGrowth(versions: readonly ScopeVersion[], sprintStartMs: number): ScopeGrowth | undefined {
  if (versions.length < 2) return undefined;
  const ordered = [...versions].sort((left, right) => left.number - right.number);
  const atStart = ordered.filter((version) => version.recordedAtEpochMs <= sprintStartMs).at(-1);
  const baseline = atStart ?? ordered[0]!;
  const head = ordered.at(-1)!;
  if (baseline === head) return undefined;
  const from = criteriaBlock(baseline.description) ?? NONE;
  const to = criteriaBlock(head.description);
  if (!to) return undefined;
  const since = atStart ? "sprintStart" : "firstVersion";
  const when = since === "sprintStart" ? "since sprint start" : "since its first version";
  if (to.items - from.items >= MIN_ADDED_ITEMS) {
    return { from, to, since, explanation: `Acceptance criteria grew from ${from.items} to ${to.items} items ${when}` };
  }
  if (from.chars > 0 && to.chars >= from.chars * (1 + MIN_TEXT_GROWTH)) {
    const percent = Math.round(((to.chars - from.chars) / from.chars) * 100);
    return { from, to, since, explanation: `Acceptance criteria text grew ${percent}% ${when}` };
  }
  return undefined;
}

/**
 * A ticket's scope growth within its sprint, from its loaded versions. Only
 * started sprints (active or closed) have a start to compare with; versions
 * older than the ticket's current head are ignored as out of date.
 */
export function ticketScope(ticket: PmTicket, sprints: readonly PmSprint[], versions: readonly ScopeVersion[] | undefined): ScopeGrowth | undefined {
  if (!versions || ticket.sprintId === null) return undefined;
  const sprint = sprints.find((candidate) => candidate.id === ticket.sprintId);
  if (!sprint || sprint.activatedAtEpochMs === null) return undefined;
  const loadedHead = versions.reduce((max, version) => Math.max(max, version.number), 0);
  if (loadedHead !== (ticket.versions?.headNumber ?? 0)) return undefined;
  return scopeGrowth(versions, sprint.activatedAtEpochMs);
}
