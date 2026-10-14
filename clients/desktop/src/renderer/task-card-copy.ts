import type { RowTone } from "./row-tone.js";
import type { AgentAttention } from "./session-presentation.js";
import type { TaskIntegration, TaskStage } from "./task-presentation.js";

/// What a board card leads with. A ticket key is how people look a Task up, so
/// it is pulled out of the title into its own scannable token, and a leading
/// `[Service]` tag becomes a scope label instead of eating the title's width.
export type TaskCardTitle = {
  key: string | undefined;
  scope: string | undefined;
  title: string;
};

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
  /// Never leave the card without a title: a title that was nothing but a key
  /// or a scope keeps its original words.
  return { key: issueKey, scope, title: rest.trim() || title.trim() };
}

/// A brief imported from Jira arrives as wiki markup (`{{code}}`, `*bold*`,
/// `h2.`, `[label|url]`). On a card it is only a one-glance reminder, so the
/// markup is dropped and the text is flattened onto a single line.
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

/// Branch prefixes like `feature/` carry no identity, and a narrow rail
/// truncates from the end, so the card shows the last path segment. The full
/// name stays in the tooltip.
export function compactBranchName(name: string): string {
  const leaf = name.slice(name.lastIndexOf("/") + 1);
  return leaf || name;
}

export type TaskCardStatus = { label: string; tone: RowTone; title: string };

/// One word for where a Task stands, read before anything else on the card.
/// Structural trouble already owns the meta-line flag, so it is not repeated
/// here; an agent that wants the user wins over delivery state, and delivery
/// state is summarised as "In review" or "Done" rather than its raw Git fact.
export function taskCardStatus(options: {
  stage: TaskStage;
  attention: AgentAttention | undefined;
  integration: TaskIntegration | undefined;
  hasLocalChanges: boolean;
  /// The collapsed card already shows a waiting agent as its action button.
  attentionShownElsewhere: boolean;
}): TaskCardStatus | undefined {
  const { stage, attention, integration, hasLocalChanges, attentionShownElsewhere } = options;
  if (stage.id !== "ready" && stage.id !== "branchOnly" && stage.id !== "planning") return undefined;
  if (attention && (attention.tone === "working" || !attentionShownElsewhere)) {
    return { label: attention.label, tone: attention.tone, title: `${attention.agent}: ${attention.label}` };
  }
  if (!integration) return undefined;
  if (integration.tone === "done" && !hasLocalChanges) {
    return { label: "Done", tone: "done", title: integration.title };
  }
  if (integration.action === "pullRequest" && integration.tone !== "done") {
    return { label: "In review", tone: integration.tone === "attention" ? "attention" : "review", title: integration.title };
  }
  return undefined;
}
