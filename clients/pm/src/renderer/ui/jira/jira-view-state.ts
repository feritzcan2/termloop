// Pure rules of the Jira issue browser, ported from Orca's task page
// (status catalog, status grouping, board sections, search input): which
// statuses the chips offer, how issues group and order, and which search a
// filter state stands for. React- and bridge-free so they are testable.
import type {
  PmJiraBoardColumn,
  PmJiraFavouriteFilter,
  PmJiraIssue,
  PmJiraProject,
  PmJiraSearchResult,
  PmJiraSearchParams,
  PmJiraSearchPreset,
  PmJiraStatus,
  PmJiraStatusCategory,
} from "@termloop/pm-contract/pm";

export type JiraPreset = Exclude<PmJiraSearchPreset, "custom">;
export type JiraViewMode = "list" | "board";

export const JIRA_PRESETS: readonly { preset: JiraPreset; label: string }[] = [
  { preset: "assigned", label: "Assigned" },
  { preset: "reported", label: "Reported" },
  { preset: "allOpen", label: "All Open" },
  { preset: "done", label: "Done" },
];

/** What the browser searches: a preset narrowed by filters, or custom JQL run as written. */
export type JiraQuery = {
  preset: PmJiraSearchPreset;
  /** Read only for the custom preset. */
  jql: string;
  jiraProjectKey: string | null;
  statuses: string[];
  currentSprint: boolean;
  text: string;
};

/** The daemon's bounds on one search; longer input is refused, not trimmed. */
export const MAX_SEARCH_TEXT_CHARS = 200;
export const MAX_SEARCH_STATUSES = 20;

/**
 * The search a query stands for. Custom JQL runs as written; project, status,
 * sprint, and text filters narrow presets only, as in Orca.
 */
export function searchParams(projectId: string, query: JiraQuery): PmJiraSearchParams {
  if (query.preset === "custom") return { projectId, preset: "custom", jql: query.jql.trim() };
  const text = query.text.trim();
  return {
    projectId,
    preset: query.preset,
    ...(query.jiraProjectKey ? { jiraProjectKey: query.jiraProjectKey } : {}),
    ...(query.statuses.length > 0 ? { statuses: query.statuses.slice(0, MAX_SEARCH_STATUSES) } : {}),
    ...(query.currentSprint ? { currentSprint: true } : {}),
    ...(text ? { text: text.slice(0, MAX_SEARCH_TEXT_CHARS) } : {}),
  };
}

/** Input written as JQL runs as a custom search on Enter instead of a text match. */
export function looksLikeJql(input: string): boolean {
  return /[=~]|\border\s+by\b|\s(?:not\s+)?in\s*\(/i.test(input.trim());
}

export type JiraStatusItem = { name: string; category: PmJiraStatusCategory | "other" };

/** A PM-local JQL filter, kept in the renderer's storage. */
export type JiraSavedFilter = { id: string; name: string; jql: string };

/** Why a Jira read failed, as the browser shows it; `notConnected` offers Settings instead of Retry. */
export type JiraFailureView = { message: string; notConnected: boolean };

/** Everything the browser shows; the composition controller owns and updates it. */
export type JiraBrowserView = {
  query: JiraQuery;
  mode: JiraViewMode;
  result: PmJiraSearchResult | undefined;
  loading: boolean;
  failure: JiraFailureView | undefined;
  projects: PmJiraProject[];
  statuses: PmJiraStatus[];
  columns: PmJiraBoardColumn[];
  favourites: PmJiraFavouriteFilter[];
  /** Statuses seen in this preset and project, so chips survive narrowing by status. */
  statusCatalog: JiraStatusItem[];
  savedFilters: JiraSavedFilter[];
  /** The saved or favourite filter whose JQL is running. */
  activeFilterId: string | undefined;
  /** Issue keys with an "Add to PM" in flight. */
  adding: string[];
};

const CATEGORY_ORDER: Record<JiraStatusItem["category"], number> = { new: 0, indeterminate: 1, done: 2, other: 3 };
export const CATEGORY_LABEL: Record<PmJiraStatusCategory, string> = { new: "To Do", indeterminate: "In Progress", done: "Done" };

const nameKey = (name: string) => name.toLowerCase();

/** Each status name's board column index; a name in several columns takes the first. */
export function statusRanks(statuses: readonly PmJiraStatus[], columns: readonly PmJiraBoardColumn[]): Map<string, number> {
  const namesById = new Map(statuses.map((status) => [status.id, nameKey(status.name)]));
  const ranks = new Map<string, number>();
  columns.forEach((column, index) => {
    for (const id of column.statusIds) {
      const name = namesById.get(id);
      if (name !== undefined && !ranks.has(name)) ranks.set(name, index);
    }
  });
  return ranks;
}

/** Board column first, then To Do, In Progress, Done, then name. */
export function compareStatuses(ranks: ReadonlyMap<string, number>) {
  return (left: JiraStatusItem, right: JiraStatusItem): number => {
    const rank = (ranks.get(nameKey(left.name)) ?? Infinity) - (ranks.get(nameKey(right.name)) ?? Infinity);
    if (rank && !Number.isNaN(rank)) return rank;
    return CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category] || left.name.localeCompare(right.name);
  };
}

/** Adds the statuses of `issues` to a catalog, keeping the first category seen per name. */
export function mergeStatusCatalog(catalog: readonly JiraStatusItem[], issues: readonly { status: JiraStatusItem }[]): JiraStatusItem[] {
  const known = new Map(catalog.map((item) => [item.name, item]));
  for (const { status } of issues) if (!known.has(status.name)) known.set(status.name, { name: status.name, category: status.category });
  return [...known.values()];
}

/** The chips to offer: the catalog plus any selected status it lacks, in board order. */
export function statusChips(catalog: readonly JiraStatusItem[], selected: readonly string[], ranks: ReadonlyMap<string, number>): JiraStatusItem[] {
  const known = new Set(catalog.map((item) => item.name));
  return [...catalog, ...selected.filter((name) => !known.has(name)).map((name) => ({ name, category: "other" as const }))]
    .sort(compareStatuses(ranks));
}

export type JiraIssueSection = { key: string; label: string; category: JiraStatusItem["category"]; issues: PmJiraIssue[] };

/** Issues grouped by status name, ordered by the board's columns, then category and name. */
export function groupIssuesByStatus(issues: readonly PmJiraIssue[], ranks: ReadonlyMap<string, number>): JiraIssueSection[] {
  const sections = new Map<string, JiraIssueSection>();
  for (const issue of issues) {
    const key = `status:${issue.status.name}`;
    const section = sections.get(key);
    if (section) section.issues.push(issue);
    else sections.set(key, { key, label: issue.status.name, category: issue.status.category, issues: [issue] });
  }
  const order = compareStatuses(ranks);
  return [...sections.values()].sort((left, right) => order({ name: left.label, category: left.category }, { name: right.label, category: right.category }));
}

export type JiraBoardLane = { key: string; label: string; fromBoard: boolean; issues: PmJiraIssue[] };

/**
 * Board lanes: the board's columns in board order (empty ones too), with
 * issues outside every column in extra lanes by status; without columns, one
 * lane per status category.
 */
export function boardLanes(issues: readonly PmJiraIssue[], statuses: readonly PmJiraStatus[], columns: readonly PmJiraBoardColumn[]): JiraBoardLane[] {
  if (columns.length === 0) {
    return (Object.keys(CATEGORY_LABEL) as PmJiraStatusCategory[]).map((category) => ({
      key: `category:${category}`,
      label: CATEGORY_LABEL[category],
      fromBoard: false,
      issues: issues.filter((issue) => issue.status.category === category),
    }));
  }
  const lanes: JiraBoardLane[] = columns.map((column, index) => ({ key: `column:${index}:${column.name}`, label: column.name, fromBoard: true, issues: [] }));
  const ranks = statusRanks(statuses, columns);
  const extras = new Map<string, JiraBoardLane>();
  for (const issue of issues) {
    const rank = ranks.get(nameKey(issue.status.name));
    if (rank !== undefined) {
      lanes[rank]!.issues.push(issue);
      continue;
    }
    const key = `status:${issue.status.name}`;
    const extra = extras.get(key) ?? { key, label: issue.status.name, fromBoard: false, issues: [] };
    extra.issues.push(issue);
    extras.set(key, extra);
  }
  return [...lanes, ...[...extras.values()].sort((left, right) => left.label.localeCompare(right.label))];
}

/** Text tone for a Jira priority name. */
export function priorityTone(priority: string | null): "high" | "medium" | "low" | undefined {
  switch (priority?.toLowerCase()) {
    case "highest": case "blocker": case "critical": case "high": case "major":
      return "high";
    case "medium": case "normal":
      return "medium";
    case "low": case "minor": case "lowest": case "trivial":
      return "low";
    default:
      return undefined;
  }
}

export function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => [...word][0]!.toUpperCase()).join("") || "?";
}
