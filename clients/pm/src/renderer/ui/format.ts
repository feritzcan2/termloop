// Presentation helpers shared by the PM views. Pure functions of contract data.
import type {
  PmAgentMode,
  PmAgentState,
  PmBoardTicket,
  PmDataTier,
  PmDeliveryRiskKind,
  PmDeliveryStageKind,
  PmSprint,
  PmTicket,
  PmTicketPriority,
  PmTicketStatus,
} from "@termloop/pm-contract/pm";

const TIER_RANK: Record<PmDataTier, number> = { tickets: 0, code: 1, deploy: 2 };

export function tierAtLeast(tier: PmDataTier, minimum: PmDataTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[minimum];
}

export const STATUS_LABEL: Record<PmTicketStatus, string> = {
  todo: "To do",
  inProgress: "In progress",
  inReview: "In review",
  done: "Done",
};

export const STATUS_ORDER: PmTicketStatus[] = ["todo", "inProgress", "inReview", "done"];

export const STAGE_LABEL: Record<PmDeliveryStageKind, string> = {
  toDo: "To do",
  inProgress: "Building",
  inReview: "In review",
  merged: "Merged",
  deployed: "Deployed",
  live: "Live",
  done: "Done",
};

export const RISK_LABEL: Record<PmDeliveryRiskKind, string> = {
  blocked: "Blocked",
  readFailed: "Source read failed",
  checksFailing: "Checks failing",
  reviewWaiting: "Waiting for review",
  stuckInStatus: "Stuck in status",
  mergedNotDeployed: "Merged, not deployed",
  notInProduction: "Not in production",
  jiraBehind: "Jira is behind",
  jiraAhead: "Jira is ahead",
  notStartedNearSprintEnd: "Not started near sprint end",
  carriedOver: "Carried over",
  unassigned: "Unassigned",
  noAcceptanceCriteria: "No acceptance criteria",
};

/** The Jira issue key from a ticket's browse URL, if it has one. */
export function jiraKey(ticket: PmTicket): string | undefined {
  const match = ticket.jiraUrl ? /\/browse\/([A-Z][A-Z0-9]*-\d+)$/.exec(ticket.jiraUrl) : null;
  return match?.[1];
}

/** A short label for a ticket: its Jira key, else a short local id. */
export function ticketLabel(ticket: PmTicket): string {
  return jiraKey(ticket) ?? `#${ticket.id.slice(0, 6)}`;
}

export function daysLeft(sprint: PmSprint, now: number): number | undefined {
  if (sprint.endsAtEpochMs === null) return undefined;
  return Math.ceil((sprint.endsAtEpochMs - now) / (24 * 60 * 60 * 1000));
}

/** The sprint the left sidebar shows: the active one, else the focused one. */
export function leftSprint(sprints: PmSprint[], focusedSprintId: string | undefined): PmSprint | undefined {
  return sprints.find((sprint) => sprint.state === "active") ?? sprints.find((sprint) => sprint.id === focusedSprintId);
}

/** When a sprint starts: its activation, else its creation. */
export function sprintStart(sprint: PmSprint): number {
  return sprint.activatedAtEpochMs ?? sprint.createdAtEpochMs;
}

/**
 * The right panel's sprint order: active first, then open sprints by start
 * date (earliest first), then closed ones by start date (latest first).
 */
export function sprintPanelOrder(sprints: PmSprint[]): PmSprint[] {
  const rank = (sprint: PmSprint) => (sprint.state === "active" ? 0 : sprint.state === "closed" ? 2 : 1);
  return [...sprints].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    const byStart = sprintStart(left) - sprintStart(right);
    return left.state === "closed" ? -byStart : byStart;
  });
}

export function sprintTickets(tickets: PmBoardTicket[], sprintId: string | undefined): PmBoardTicket[] {
  return tickets
    .filter((entry) => (sprintId === undefined ? entry.ticket.sprintId === null : entry.ticket.sprintId === sprintId))
    .sort((left, right) => left.ticket.rank - right.ticket.rank);
}

/** A lane split by status in {@link STATUS_ORDER}, empty statuses left out, lane order kept within each. */
export function statusSections(lane: PmBoardTicket[]): { status: PmTicketStatus; tickets: PmBoardTicket[] }[] {
  return STATUS_ORDER
    .map((status) => ({ status, tickets: lane.filter((entry) => entry.ticket.status === status) }))
    .filter((section) => section.tickets.length > 0);
}

/** Tickets whose code shipped but whose deployment is not known. */
export function unknownDeployment(tickets: PmBoardTicket[]): PmBoardTicket[] {
  return tickets.filter((entry) =>
    entry.delivery.stage.kind === "merged"
    || entry.delivery.risks.some((risk) => risk.kind === "mergedNotDeployed" || risk.kind === "notInProduction"));
}

export function relativeTime(epochMs: number, now: number): string {
  const minutes = Math.round((now - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const PRIORITY_LABEL: Record<PmTicketPriority, string> = {
  lowest: "Lowest",
  low: "Low",
  medium: "Medium",
  high: "High",
  highest: "Highest",
};

export const PRIORITY_ORDER: PmTicketPriority[] = ["highest", "high", "medium", "low", "lowest"];

/** The sidebar status dot class of a ticket status. */
export const STATUS_DOT: Record<PmTicketStatus, "todo" | "progress" | "inreview" | "done"> = {
  todo: "todo",
  inProgress: "progress",
  inReview: "inreview",
  done: "done",
};

export type AgentTone = "working" | "awaiting" | "review" | "exited";

/** The rail dot tone of an agent session: a check reviews, the assistant works. */
export function agentTone(state: PmAgentState, mode: PmAgentMode): AgentTone {
  if (state === "exited") return "exited";
  if (state === "starting") return "awaiting";
  return mode === "deliveryCheck" ? "review" : "working";
}

/** Risks that read as "bad" (danger) in the sidebar; every other risk is a warning. */
const SEVERE_RISKS: ReadonlySet<PmDeliveryRiskKind> = new Set(["blocked", "checksFailing", "readFailed"]);

export function riskTone(kind: PmDeliveryRiskKind): "bad" | "warn" {
  return SEVERE_RISKS.has(kind) ? "bad" : "warn";
}

export type AttentionRow = {
  ticketId: string;
  label: string;
  status: PmTicketStatus;
  /** The risk labels, worst first. */
  title: string;
  detail: string;
  tone: "bad" | "warn";
};

/** One row per ticket with at least one delivery risk, severe ones first, in rank order. */
export function attentionRows(tickets: PmBoardTicket[]): AttentionRow[] {
  const rows = tickets
    .filter((entry) => entry.delivery.risks.length > 0)
    .map((entry) => {
      const risks = [...entry.delivery.risks].sort((left, right) => Number(SEVERE_RISKS.has(right.kind)) - Number(SEVERE_RISKS.has(left.kind)));
      const tone = riskTone(risks[0]!.kind);
      return {
        ticketId: entry.ticket.id,
        label: ticketLabel(entry.ticket),
        status: entry.ticket.status,
        title: risks.map((risk) => RISK_LABEL[risk.kind]).join(", "),
        // A detail that only repeats its label adds nothing.
        detail: risks.map((risk) => risk.detail).filter((detail, index) => detail && detail.toLowerCase() !== RISK_LABEL[risks[index]!.kind].toLowerCase()).join("; "),
        tone,
        rank: entry.ticket.rank,
      };
    });
  rows.sort((left, right) => Number(right.tone === "bad") - Number(left.tone === "bad") || left.rank - right.rank);
  return rows.map(({ rank: _rank, ...row }) => row);
}

export type RulerDay = { epochMs: number; label: string; kind: "past" | "today" | "future"; weekend: boolean };

/** A sprint ruler longer than this is not drawn day by day. */
const MAX_RULER_DAYS = 42;

function startOfDay(epochMs: number): number {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * One cell per calendar day from the sprint's start (activation, else
 * creation) to its end, in local time. Empty without an end date or when the
 * span is not drawable.
 */
export function dayRuler(sprint: PmSprint, now: number): RulerDay[] {
  if (sprint.endsAtEpochMs === null) return [];
  const first = startOfDay(sprint.activatedAtEpochMs ?? sprint.createdAtEpochMs);
  const last = startOfDay(sprint.endsAtEpochMs);
  const today = startOfDay(now);
  const days: RulerDay[] = [];
  for (let day = first; day <= last && days.length <= MAX_RULER_DAYS; ) {
    const date = new Date(day);
    days.push({
      epochMs: day,
      label: String(date.getDate()),
      kind: day < today ? "past" : day === today ? "today" : "future",
      weekend: date.getDay() === 0 || date.getDay() === 6,
    });
    date.setDate(date.getDate() + 1);
    day = date.getTime();
  }
  return days.length > MAX_RULER_DAYS ? [] : days;
}

/** "day X of N" for a sprint with a start and an end; `undefined` otherwise. */
export function sprintDay(sprint: PmSprint, now: number): { day: number; of: number } | undefined {
  const days = dayRuler(sprint, now);
  if (days.length === 0) return undefined;
  const today = days.findIndex((day) => day.kind === "today");
  const day = today >= 0 ? today + 1 : days[0]!.kind === "future" ? 0 : days.length;
  return { day, of: days.length };
}

export type RibbonSegment = { key: string; label: string; count: number };

/**
 * Sprint tickets by status for the overview ribbon. From the code tier on,
 * unfinished tickets whose code merged but is not live get their own segment.
 */
export function statusRibbon(tickets: PmBoardTicket[], tier: PmDataTier): RibbonSegment[] {
  const mergedOnly = (entry: PmBoardTicket) =>
    tierAtLeast(tier, "code") && entry.ticket.status !== "done" && (entry.delivery.stage.kind === "merged" || entry.delivery.stage.kind === "deployed");
  const count = (status: PmTicketStatus) => tickets.filter((entry) => entry.ticket.status === status && !mergedOnly(entry)).length;
  const segments: RibbonSegment[] = [
    { key: "todo", label: "to do", count: count("todo") },
    { key: "inProgress", label: "in progress", count: count("inProgress") },
    { key: "inReview", label: "in review", count: count("inReview") },
  ];
  if (tierAtLeast(tier, "code")) segments.push({ key: "merged", label: "merged, not live", count: tickets.filter(mergedOnly).length });
  segments.push({ key: "done", label: "done", count: count("done") });
  return segments;
}

/** The newest Jira pull time recorded on any sprint or ticket. */
export function lastJiraPull(sprints: PmSprint[], tickets: PmBoardTicket[]): number | undefined {
  let latest: number | undefined;
  for (const value of [...sprints.map((sprint) => sprint.jiraPulledAtEpochMs), ...tickets.map((entry) => entry.ticket.jiraPulledAtEpochMs)]) {
    if (value !== null && (latest === undefined || value > latest)) latest = value;
  }
  return latest;
}
