import type {
  EnvironmentDeployState,
  FactSource,
  ProjectManagerTicketSaveParams,
  TaskTicketContentDto,
} from "@termloop/contract/current";

import type { Task } from "../model.js";
import { taskBriefBlocks } from "./TaskBrief.js";

/// What the Project Manager edits on a ticket: its title and Markdown
/// description. Delivery facts are machine-owned and never part of it.
export type TicketDraft = {
  title: string;
  brief: string;
};

export const ENVIRONMENT_STATES: readonly { value: EnvironmentDeployState; label: string }[] = [
  { value: "unknown", label: "Unknown" },
  { value: "notDeployed", label: "Not deployed" },
  { value: "inProgress", label: "Deploying" },
  { value: "deployed", label: "Deployed" },
];

export function environmentStateLabel(state: EnvironmentDeployState): string {
  return ENVIRONMENT_STATES.find((candidate) => candidate.value === state)?.label ?? state;
}

/// Where a delivery fact came from, as the ticket names it.
export function factSourceLabel(source: FactSource): string {
  switch (source) {
    case "jira": return "Jira";
    case "gitHost": return "Pull requests";
    case "probe": return "Probe";
    case "check": return "Delivery check";
    case "projectManager": return "You";
  }
}

const JIRA_INLINE = /\{\{([^{}\n]+)\}\}|\*([^*\n]+)\*/gu;

function jiraInlineMarkdown(text: string): string {
  return text.replace(JIRA_INLINE, (_match, code: string | undefined, strong: string | undefined) =>
    code !== undefined ? `\`${code}\`` : `**${strong}**`);
}

/// A Jira wiki description, as Jira imports carry it, in Markdown.
export function jiraWikiToMarkdown(brief: string): string {
  return taskBriefBlocks(brief, "jiraWiki").map((block) => {
    switch (block.kind) {
      case "heading": return `## ${jiraInlineMarkdown(block.text)}`;
      case "paragraph": return block.lines.map(jiraInlineMarkdown).join("  \n");
      case "list": return block.items.map((item) => `- ${jiraInlineMarkdown(item)}`).join("\n");
      case "code": return `\`\`\`\n${block.text}\n\`\`\``;
    }
  }).join("\n\n");
}

/// The ticket as saved. A Jira-imported description that was never saved
/// through the editor is still Jira wiki and is shown as Markdown.
export function ticketDraft(task: Task, versioned: boolean): TicketDraft {
  const brief = task.brief ?? "";
  return {
    title: task.title,
    brief: !versioned && task.jira_url && brief ? jiraWikiToMarkdown(brief) : brief,
  };
}

const text = (value: string) => value.trim() || null;

/// The whole ticket the daemon saves as its next version; a blank
/// description clears it.
export function ticketSaveParams(
  taskId: string,
  draft: TicketDraft,
  summary: string,
  expectedVersion: number | null,
): ProjectManagerTicketSaveParams {
  return {
    taskId,
    title: draft.title.trim(),
    brief: text(draft.brief),
    summary: text(summary),
    expectedVersion,
  };
}

export function sameTicket(left: TicketDraft, right: TicketDraft): boolean {
  return left.title.trim() === right.title.trim() && left.brief.trim() === right.brief.trim();
}

export type TicketFieldChange = { field: string; before: string; after: string };

/// The fields other than the description that differ between two versions.
export function ticketFieldChanges(before: TaskTicketContentDto | undefined, after: TaskTicketContentDto): TicketFieldChange[] {
  const title = before?.title ?? "";
  return title === after.title ? [] : [{ field: "Title", before: title, after: after.title }];
}

export function isRevisionConflict(message: string): boolean {
  return /revision/iu.test(message);
}

export function relativeTime(epochMs: number, now = Date.now()): string {
  const minutes = Math.round((now - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
