import type {
  EnvironmentDeployState,
  ProjectManagerTicketSaveParams,
  TaskTicketContentDto,
  TaskTrackingDto,
} from "@termloop/contract/current";

import type { Task } from "../model.js";
import { taskBriefBlocks } from "./TaskBrief.js";

export type EnvironmentDraft = { name: string; state: EnvironmentDeployState; detail: string };

/// What the Project Manager edits on a ticket. The description is Markdown.
export type TicketDraft = {
  title: string;
  brief: string;
  developer: string;
  jiraStatus: string;
  environments: EnvironmentDraft[];
  blockers: string;
  note: string;
};

export const ENVIRONMENT_STATES: readonly { value: EnvironmentDeployState; label: string }[] = [
  { value: "unknown", label: "Unknown" },
  { value: "notDeployed", label: "Not deployed" },
  { value: "inProgress", label: "Deploying" },
  { value: "deployed", label: "Deployed" },
];

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
export function ticketDraft(task: Task, tracking: TaskTrackingDto | undefined, versioned: boolean): TicketDraft {
  const brief = task.brief ?? "";
  return {
    title: task.title,
    brief: !versioned && task.jira_url && brief ? jiraWikiToMarkdown(brief) : brief,
    developer: tracking?.developer ?? "",
    jiraStatus: tracking?.jiraStatus ?? "",
    environments: (tracking?.environments ?? []).map((environment) => ({
      name: environment.name,
      state: environment.state,
      detail: environment.detail ?? "",
    })),
    blockers: tracking?.blockers ?? "",
    note: tracking?.note ?? "",
  };
}

export function contentDraft(content: TaskTicketContentDto): TicketDraft {
  return {
    title: content.title,
    brief: content.brief ?? "",
    developer: content.developer ?? "",
    jiraStatus: content.jiraStatus ?? "",
    environments: content.environments.map((environment) => ({ ...environment, detail: environment.detail ?? "" })),
    blockers: content.blockers ?? "",
    note: content.note ?? "",
  };
}

const text = (value: string) => value.trim() || null;

/// The whole ticket the daemon saves as its next version; blank fields
/// clear and blank environment names are dropped.
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
    developer: text(draft.developer),
    jiraStatus: text(draft.jiraStatus),
    environments: draft.environments
      .filter((environment) => environment.name.trim())
      .map((environment) => ({ name: environment.name.trim(), state: environment.state, detail: text(environment.detail) })),
    blockers: text(draft.blockers),
    note: text(draft.note),
    summary: text(summary),
    expectedVersion,
  };
}

export function sameTicket(left: TicketDraft, right: TicketDraft): boolean {
  const comparable = (draft: TicketDraft) => {
    const { summary: _summary, expectedVersion: _version, ...rest } = ticketSaveParams("", draft, "", null);
    return JSON.stringify(rest);
  };
  return comparable(left) === comparable(right);
}

export type TicketFieldChange = { field: string; before: string; after: string };

function environmentsText(environments: TaskTicketContentDto["environments"]): string {
  return environments
    .map((environment) => `${environment.name}: ${ENVIRONMENT_STATES.find((state) => state.value === environment.state)?.label ?? environment.state}${environment.detail ? ` (${environment.detail})` : ""}`)
    .join(", ");
}

/// The fields other than the description that differ between two versions.
export function ticketFieldChanges(before: TaskTicketContentDto | undefined, after: TaskTicketContentDto): TicketFieldChange[] {
  const fields: { field: string; read(content: TaskTicketContentDto): string }[] = [
    { field: "Title", read: (content) => content.title },
    { field: "Developer", read: (content) => content.developer ?? "" },
    { field: "Jira status", read: (content) => content.jiraStatus ?? "" },
    { field: "Environments", read: (content) => environmentsText(content.environments) },
    { field: "Blockers", read: (content) => content.blockers ?? "" },
    { field: "Note", read: (content) => content.note ?? "" },
  ];
  return fields
    .map(({ field, read }) => ({ field, before: before ? read(before) : "", after: read(after) }))
    .filter((change) => change.before !== change.after);
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
