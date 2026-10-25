// Pure rules of the ticket editor: when a description counts as edited, and
// which field updates a committed input produces. React- and editor-free so
// they are testable without a DOM.
import type { PmSprint, PmTicket, PmTicketUpdateParams } from "@termloop/pm-contract/pm";

export type TicketFieldUpdate = Omit<PmTicketUpdateParams, "ticketId">;

/**
 * The description as the editor holds it. `baseline` is the editor's own
 * Markdown for the saved text, so formatting the editor normalises (list
 * markers, spacing) is never mistaken for an edit; `touched` is set only by
 * the user's own input or by loading an older version into the editor.
 */
export type DescriptionDraft = { text: string; baseline: string; touched: boolean };

export function descriptionEdited(draft: DescriptionDraft): boolean {
  return draft.touched && draft.text.trim() !== draft.baseline.trim();
}

/** ⌘S on macOS, Ctrl+S elsewhere; never with Alt. */
export function isSaveShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s";
}

/** A committed title; an empty or unchanged one changes nothing. */
export function titleUpdate(input: string, ticket: PmTicket): TicketFieldUpdate | undefined {
  const title = input.trim();
  return title && title !== ticket.title ? { title } : undefined;
}

/** A committed assignee; an empty input unassigns. */
export function assigneeUpdate(input: string, ticket: PmTicket): TicketFieldUpdate | undefined {
  const assignee = input.trim() === "" ? null : input.trim();
  return assignee === ticket.assignee ? undefined : { assignee };
}

const JIRA_ISSUE_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\/browse\/[A-Z][A-Z0-9]{0,63}-[1-9][0-9]{0,19}$/u;

/** A committed Jira link: an issue's browse URL, or empty to unlink. */
export function jiraUrlUpdate(input: string, ticket: PmTicket): TicketFieldUpdate | "invalid" | undefined {
  const value = input.trim();
  const jiraUrl = value === "" ? null : value;
  if (jiraUrl === ticket.jiraUrl) return undefined;
  if (jiraUrl !== null && !JIRA_ISSUE_URL.test(jiraUrl)) return "invalid";
  return { jiraUrl };
}

/** The sprints a ticket can move to: every open sprint, plus its own. */
export function sprintChoices(sprints: PmSprint[], current: string | null): PmSprint[] {
  return sprints.filter((sprint) => sprint.id === current || sprint.state !== "closed");
}
