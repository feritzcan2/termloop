// Renderer-local memory of the Jira issue browser: the last filters and view
// per PM project, and the PM's saved JQL filters (Orca's saved-filter rules).
// The daemon owns none of it; a blocked store only loses what was remembered.
import { JIRA_PRESETS, MAX_SEARCH_STATUSES, type JiraPreset, type JiraSavedFilter, type JiraViewMode } from "../ui/jira/jira-view-state.js";
import { defaultStorage, type PreferenceSource, type PreferenceTarget } from "./right-sidebar-preference.js";

const PREFERENCE_KEY = "termloop.pm.jiraBrowser.v1";
const SAVED_FILTERS_KEY = "termloop.pm.jiraSavedFilters.v1";

/** Projects remembered at once; the least recently changed is dropped first. */
export const MAX_REMEMBERED_PROJECTS = 50;

export type JiraBrowserPreference = {
  preset: JiraPreset;
  jiraProjectKey: string | null;
  statuses: string[];
  currentSprint: boolean;
  mode: JiraViewMode;
};

export const DEFAULT_JIRA_BROWSER: JiraBrowserPreference = { preset: "assigned", jiraProjectKey: null, statuses: [], currentSprint: false, mode: "list" };

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

function readJson(key: string, storage: PreferenceSource): unknown {
  try {
    return JSON.parse((storage ?? defaultStorage())?.getItem(key) ?? "null") as unknown;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown, storage: PreferenceTarget): void {
  try {
    (storage ?? defaultStorage())?.setItem(key, JSON.stringify(value));
  } catch {
    // An unavailable store must not prevent in-session use.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeJiraBrowserPreference(value: unknown): JiraBrowserPreference {
  if (!isRecord(value)) return DEFAULT_JIRA_BROWSER;
  const { preset, jiraProjectKey, statuses, currentSprint, mode } = value;
  return {
    preset: JIRA_PRESETS.find((candidate) => candidate.preset === preset)?.preset ?? DEFAULT_JIRA_BROWSER.preset,
    jiraProjectKey: typeof jiraProjectKey === "string" && PROJECT_KEY.test(jiraProjectKey) ? jiraProjectKey : null,
    statuses: Array.isArray(statuses)
      ? [...new Set(statuses.filter((name): name is string => typeof name === "string" && name.trim() !== "" && name.length <= 255))].slice(0, MAX_SEARCH_STATUSES)
      : [],
    currentSprint: currentSprint === true,
    mode: mode === "board" ? "board" : "list",
  };
}

function readAll(storage: PreferenceSource): Record<string, unknown> {
  const parsed = readJson(PREFERENCE_KEY, storage);
  return isRecord(parsed) ? parsed : {};
}

export function readJiraBrowserPreference(projectId: string, storage?: PreferenceSource): JiraBrowserPreference {
  return normalizeJiraBrowserPreference(readAll(storage)[projectId]);
}

export function writeJiraBrowserPreference(
  projectId: string,
  preference: JiraBrowserPreference,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  const all = readAll(storage);
  delete all[projectId];
  const entries = [...Object.entries(all), [projectId, preference] as const].slice(-MAX_REMEMBERED_PROJECTS);
  writeJson(PREFERENCE_KEY, Object.fromEntries(entries), storage);
}

// Saved filters ---------------------------------------------------------------

export const MAX_SAVED_FILTERS = 50;
export const MAX_SAVED_FILTER_NAME_LENGTH = 80;
export const MAX_SAVED_FILTER_JQL_BYTES = 8 * 1024;
const MAX_SAVED_FILTER_ID_LENGTH = 128;

export type { JiraSavedFilter } from "../ui/jira/jira-view-state.js";

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

export function jqlWithinLimit(jql: string): boolean {
  return new TextEncoder().encode(jql).length <= MAX_SAVED_FILTER_JQL_BYTES;
}

/** Drops malformed, oversized, and duplicate (id or case-insensitive name) entries; keeps at most 50. */
export function normalizeSavedFilters(value: unknown): JiraSavedFilter[] {
  if (!Array.isArray(value)) return [];
  const filters: JiraSavedFilter[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const id = bounded(candidate.id, MAX_SAVED_FILTER_ID_LENGTH);
    const name = bounded(candidate.name, MAX_SAVED_FILTER_NAME_LENGTH);
    const jql = bounded(candidate.jql, MAX_SAVED_FILTER_JQL_BYTES);
    if (!id || !name || !jql || !jqlWithinLimit(jql) || ids.has(id) || names.has(name.toLowerCase())) continue;
    filters.push({ id, name, jql });
    ids.add(id);
    names.add(name.toLowerCase());
    if (filters.length === MAX_SAVED_FILTERS) break;
  }
  return filters;
}

/**
 * Saves a new filter or replaces the one with the same id. Returns the new
 * list, or why the save was refused.
 */
export function saveFilter(filters: readonly JiraSavedFilter[], filter: JiraSavedFilter): JiraSavedFilter[] | { error: string } {
  const [valid] = normalizeSavedFilters([filter]);
  if (!valid) return { error: "Give the filter a name and JQL under 8 KiB." };
  const existing = filters.some((item) => item.id === valid.id);
  if (!existing && filters.length >= MAX_SAVED_FILTERS) return { error: `You can save up to ${MAX_SAVED_FILTERS} filters.` };
  if (filters.some((item) => item.id !== valid.id && item.name.toLowerCase() === valid.name.toLowerCase())) {
    return { error: "A saved filter with this name already exists." };
  }
  return existing ? filters.map((item) => (item.id === valid.id ? valid : item)) : [...filters, valid];
}

export function readSavedFilters(storage?: PreferenceSource): JiraSavedFilter[] {
  return normalizeSavedFilters(readJson(SAVED_FILTERS_KEY, storage));
}

export function writeSavedFilters(filters: readonly JiraSavedFilter[], storage?: PreferenceTarget): void {
  writeJson(SAVED_FILTERS_KEY, filters, storage);
}
