import type { TaskDto } from "@termloop/contract/current";

import type { AgentRow, TaskRow } from "./attention-overview";
import { taskJiraIssueKey } from "./dto-readers";
import { taskChangeCount, type TaskStageId } from "./task-presentation";

export const taskFilters = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs you" },
  { id: "active", label: "In progress" },
  { id: "ready", label: "Ready" },
  { id: "setup", label: "Setup" },
] as const;
export type TaskFilter = typeof taskFilters[number]["id"];

export interface TaskBrowserItem {
  readonly row: TaskRow;
  readonly task: TaskDto;
  readonly status: string;
  readonly statusDetail: string | undefined;
  readonly agentActionLabel: string;
  readonly filter: Exclude<TaskFilter, "all">;
  readonly issueKey: string | undefined;
  readonly changeCount: number | undefined;
  readonly agent: AgentRow | undefined;
  /// Every live attached agent, loudest first, so the card can list them the
  /// way the desktop sidebar discloses a Task's Sessions.
  readonly agents: readonly AgentRow[];
  readonly card: TaskCardTitle;
  readonly brief: string | undefined;
}

/// What a card leads with, matching the desktop sidebar: the ticket key comes
/// out of the title as its own token and a leading `[Service]` tag becomes a
/// scope label instead of eating the title's width.
export interface TaskCardTitle {
  readonly key: string | undefined;
  readonly scope: string | undefined;
  readonly title: string;
}

const LEADING_SCOPE = /^\s*\[([^\]]{1,40})\]\s*/;

export function taskCardTitle(title: string, issueKey: string | undefined): TaskCardTitle {
  let rest = title.trim();
  if (issueKey) {
    const escaped = issueKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rest = rest.replace(new RegExp(`^\\s*\\[?${escaped}\\]?\\s*[:\\-–—]?\\s*`, "i"), "");
  }
  const scopeMatch = LEADING_SCOPE.exec(rest);
  const scope = scopeMatch?.[1]?.trim() || undefined;
  if (scopeMatch) rest = rest.slice(scopeMatch[0].length);
  return { key: issueKey, scope, title: rest.trim() || title.trim() };
}

/// A Jira brief arrives as wiki markup; on a card it is a one-glance reminder,
/// so the markup is dropped and the text flattened onto one line.
export function plainTaskBrief(brief: string | null | undefined): string | undefined {
  if (!brief) return undefined;
  const text = brief
    .replace(/\{(?:code|noformat|quote|panel|color)(?::[^}]*)?\}/gi, " ")
    .replace(/\{\{([^}]*)\}\}/g, "$1")
    .replace(/\[([^\]|]+)\|[^\]]+\]/g, "$1")
    .replace(/\[(https?:[^\]]+)\]/g, "$1")
    .replace(/^\s*h[1-6]\.\s*/gim, "")
    .replace(/^\s*(?:[*#-]+|\|\|?)\s+/gm, "")
    .replace(/\|\|?/g, " ")
    .replace(/(^|[\s(])[*_]{1,2}(\S(?:[^*_\n]*\S)?)[*_]{1,2}(?=[\s).,:;!?]|$)/gm, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/// Branch prefixes like `feature/` carry no identity on a narrow card.
export function compactBranchName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1) || name;
}

const agentToneRank: Record<AgentRow["tone"], number> = {
  attention: 0, review: 1, blocked: 2, interrupted: 3, working: 4, busy: 5, quiet: 6, done: 7,
};

const stageLabels: Record<TaskStageId, string> = {
  closed: "Closed",
  planning: "Setup needed",
  branchOnly: "Setup needed",
  provisioning: "Preparing workspace",
  provisioningFailed: "Setup failed",
  repair: "Needs repair",
  unavailable: "Unavailable",
  ready: "Ready to start",
};

export function taskAttachedAgents(task: TaskDto, agents: readonly AgentRow[]): AgentRow[] {
  const attached = new Set(task.worktree_presence?.attached_sessions.map((entry) => entry.session_id));
  return agents.filter((agent) => attached.has(agent.sessionId));
}

// Search and filters only shape the current projection. They never assign a
// lifecycle or persist a second task status on the phone.
export function buildTaskBrowserItems(
  rows: readonly TaskRow[],
  tasks: readonly TaskDto[],
  agents: readonly AgentRow[],
): TaskBrowserItem[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const agentsById = new Map(agents.map((agent) => [agent.sessionId, agent]));
  return rows.flatMap<TaskBrowserItem>((row) => {
    const task = tasksById.get(row.taskId);
    if (task === undefined) return [];
    const live = (task.worktree_presence?.attached_sessions ?? [])
      .map((entry) => agentsById.get(entry.session_id))
      .filter((entry): entry is AgentRow => entry?.attachable === true)
      .sort((left, right) => Number(right.sessionId === row.attention?.sessionId) - Number(left.sessionId === row.attention?.sessionId)
        || agentToneRank[left.tone] - agentToneRank[right.tone]);
    const agent = live[0];
    const issueKey = task.jira_url ? taskJiraIssueKey(task.jira_url) : undefined;
    const filter = row.tone === "attention" || row.tone === "blocked" || row.tone === "review" || row.tone === "interrupted"
      ? "attention"
      : row.tone === "working" || row.tone === "busy"
        ? "active"
        : row.stage.id === "ready" ? "ready" : "setup";
    const status = row.stage.tone === "blocked" || row.stage.id === "provisioning"
      ? stageLabels[row.stage.id]
      : row.attention?.tone === "attention" ? "Waiting for you"
        : row.attention?.tone === "review" ? "Ready for review"
          : row.attention?.tone === "working" ? "Agent working"
            : row.stage.id === "ready" && agent ? "Agent available" : stageLabels[row.stage.id];
    const statusDetail = row.stage.tone === "blocked" ? "Needs a fix on your Mac."
      : row.attention?.tone === "attention" ? `${row.attention.agent} needs your reply to continue.`
        : row.attention?.tone === "review" ? `${row.attention.agent}'s work is ready to review.`
          : row.attention?.tone === "working" ? `${row.attention.agent} is working on this task.` : undefined;
    const agentActionLabel = row.attention?.tone === "attention" ? "Reply now"
      : row.attention?.tone === "review" ? "Review now"
        : row.attention?.tone === "working" ? "View progress" : "Open agent";
    return [{
      row, task, status, statusDetail, agentActionLabel, filter, agent, agents: live, issueKey,
      changeCount: taskChangeCount(task),
      card: taskCardTitle(task.title, issueKey),
      brief: plainTaskBrief(task.brief),
    }];
  }).sort((left, right) => filterPriority(left.filter) - filterPriority(right.filter));
}

function filterPriority(filter: TaskBrowserItem["filter"]): number {
  return filter === "attention" ? 0 : filter === "active" ? 1 : 2;
}

export function filterTaskItems(items: readonly TaskBrowserItem[], filter: TaskFilter, query: string): TaskBrowserItem[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filter !== "all" && item.filter !== filter) return false;
    const searchable = [item.task.title, item.task.brief, item.task.branch?.name, item.issueKey].filter(Boolean).join(" ").toLocaleLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}
