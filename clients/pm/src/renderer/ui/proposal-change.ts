// What a proposed change is, as plain data: its label, whether it reaches
// Jira, and the text it replaces. React-free so the controller can use it.
import type { PmProposalChange, PmTicket } from "@termloop/pm-contract/pm";

const KIND_LABELS: Record<PmProposalChange["kind"], string> = {
  description: "description",
  acceptanceCriteria: "acceptance criteria",
  blockers: "blockers",
  status: "status",
  assignee: "assignee",
  sprint: "sprint",
  jiraComment: "Jira comment",
};

export function proposalKindLabel(change: PmProposalChange): string {
  return KIND_LABELS[change.kind];
}

/** Whether accepting the change leaves something to write to Jira. */
export function touchesJira(change: PmProposalChange): boolean {
  return change.kind === "description" || change.kind === "status" || change.kind === "sprint" || change.kind === "jiraComment";
}

/** The ticket's current text and the proposed text, for the kinds shown as a diff. */
export function textChange(change: PmProposalChange, ticket: PmTicket): { current: string; proposed: string } | undefined {
  switch (change.kind) {
    case "description":
      return { current: ticket.description, proposed: change.description };
    case "acceptanceCriteria":
      return { current: ticket.acceptanceCriteria.map((item) => item.text).join("\n"), proposed: change.criteria.join("\n") };
    case "blockers":
      return { current: ticket.blockers.map((item) => item.text).join("\n"), proposed: change.blockers.join("\n") };
    default:
      return undefined;
  }
}
