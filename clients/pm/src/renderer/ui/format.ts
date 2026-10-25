// Presentation helpers shared by the PM views. Pure functions of contract data.
import type {
  PmBoardTicket,
  PmDataTier,
  PmDeliveryRiskKind,
  PmDeliveryStageKind,
  PmSprint,
  PmTicket,
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

export function sprintTickets(tickets: PmBoardTicket[], sprintId: string | undefined): PmBoardTicket[] {
  return tickets
    .filter((entry) => (sprintId === undefined ? entry.ticket.sprintId === null : entry.ticket.sprintId === sprintId))
    .sort((left, right) => left.ticket.rank - right.ticket.rank);
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
