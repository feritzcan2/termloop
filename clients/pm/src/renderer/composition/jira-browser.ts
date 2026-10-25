// The Jira issue browser's controller: filter intents → allowlisted Jira
// reads through `window.pm` → its own small store. Read-only toward Jira;
// "Add to PM" creates a PM ticket through the injected callback. React-free
// so it is testable with a fake bridge.
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PmJiraFailure, PmJiraIssue } from "@termloop/pm-contract/pm";
import type { PmApi, PmCallError } from "../../pm-api.js";
import {
  readJiraBrowserPreference,
  readSavedFilters,
  saveFilter,
  writeJiraBrowserPreference,
  writeSavedFilters,
} from "../state/jira-browser-preference.js";
import {
  mergeStatusCatalog,
  searchParams,
  type JiraBrowserView,
  type JiraFailureView,
  type JiraPreset,
  type JiraQuery,
  type JiraViewMode,
} from "../ui/jira/jira-view-state.js";

export type JiraBrowserState = JiraBrowserView;
export type JiraBrowserStore = StoreApi<JiraBrowserState>;
type Bridge = Pick<PmApi, "call">;
/** Creates a PM ticket linked to the issue; resolves its id. */
export type AddIssueToPm = (issue: PmJiraIssue) => Promise<string | undefined>;

const FAILURE_MESSAGE: Record<PmJiraFailure, string> = {
  notConfigured: "Jira is not connected for this project.",
  credentialMissing: "The Jira API token is missing. Add it in Settings.",
  invalidSite: "The Jira site URL is not valid.",
  invalidRequest: "Jira could not run this search. Check the JQL.",
  unauthorized: "Jira refused the stored token. Update it in Settings.",
  forbidden: "This Jira account cannot read these issues.",
  notFound: "Jira could not find what this search asks for.",
  rejected: "Jira rejected this search. Check the JQL.",
  rateLimited: "Jira is rate limiting requests. Try again shortly.",
  unavailable: "Jira is unavailable right now.",
  responseTooLarge: "Jira's response was too large.",
  malformedResponse: "Jira returned a response the PM could not read.",
};

export function jiraFailureView(error: PmCallError): JiraFailureView {
  const details = error.details as { kind?: string; reason?: PmJiraFailure; parameter?: string } | undefined;
  if (details?.kind === "jiraFailed" && details.reason) {
    return { message: FAILURE_MESSAGE[details.reason] ?? error.message, notConnected: details.reason === "notConfigured" || details.reason === "credentialMissing" };
  }
  if (details?.kind === "invalidParameter") return { message: `The search's ${details.parameter ?? "input"} is not valid.`, notConnected: false };
  return { message: error.message, notConnected: false };
}

export class JiraBrowserController {
  readonly store: JiraBrowserStore;
  #searchSeq = 0;
  /** The preset a custom search returns to; custom JQL itself is not remembered. */
  #lastPreset: JiraPreset;

  constructor(
    readonly bridge: Bridge,
    readonly projectId: string,
    readonly addIssueToPm: AddIssueToPm,
    readonly storage?: Pick<Storage, "getItem" | "setItem">,
  ) {
    const preference = readJiraBrowserPreference(projectId, storage);
    this.#lastPreset = preference.preset;
    this.store = createStore<JiraBrowserState>(() => ({
      query: { preset: preference.preset, jql: "", jiraProjectKey: preference.jiraProjectKey, statuses: preference.statuses, currentSprint: preference.currentSprint, text: "" },
      mode: preference.mode,
      result: undefined,
      loading: false,
      failure: undefined,
      projects: [],
      statuses: [],
      columns: [],
      favourites: [],
      statusCatalog: [],
      savedFilters: readSavedFilters(storage),
      activeFilterId: undefined,
      adding: [],
    }));
  }

  get state(): JiraBrowserState {
    return this.store.getState();
  }

  #set(patch: Partial<JiraBrowserState>): void {
    this.store.setState(patch);
  }

  /** Reads the pickers' catalogues and runs the remembered search. */
  async start(): Promise<void> {
    await Promise.all([this.search(), this.#loadProjects(), this.#loadFavourites(), this.#loadStatuses()]);
  }

  // Catalogue failures stay quiet: the search reports the same failure.
  async #loadProjects(): Promise<void> {
    const outcome = await this.bridge.call("pm_jira_projects_read", { projectId: this.projectId });
    if (outcome.ok) this.#set({ projects: [...outcome.result.projects].sort((left, right) => left.name.localeCompare(right.name)) });
  }

  async #loadFavourites(): Promise<void> {
    const outcome = await this.bridge.call("pm_jira_favourite_filters_read", { projectId: this.projectId });
    if (outcome.ok) this.#set({ favourites: outcome.result.filters });
  }

  async #loadStatuses(): Promise<void> {
    const jiraProjectKey = this.state.query.jiraProjectKey;
    const outcome = await this.bridge.call("pm_jira_statuses_read", { projectId: this.projectId, jiraProjectKey });
    if (outcome.ok && this.state.query.jiraProjectKey === jiraProjectKey) this.#set({ statuses: outcome.result.statuses, columns: outcome.result.columns });
  }

  /** Runs the current query; only the latest search's answer is shown. */
  async search(): Promise<void> {
    const seq = ++this.#searchSeq;
    const query = this.state.query;
    if (query.preset === "custom" && !query.jql.trim()) return;
    this.#set({ loading: true, failure: undefined });
    const outcome = await this.bridge.call("pm_jira_search", searchParams(this.projectId, query));
    if (seq !== this.#searchSeq) return;
    if (!outcome.ok) {
      this.#set({ loading: false, failure: jiraFailureView(outcome.error) });
      return;
    }
    const result = outcome.result;
    // Chips come from issues found without a status filter, as in Orca.
    const statusCatalog = query.statuses.length === 0 && query.preset !== "custom"
      ? mergeStatusCatalog(this.state.statusCatalog, result.issues)
      : this.state.statusCatalog;
    this.#set({ loading: false, result, statusCatalog });
  }

  #update(query: Partial<JiraQuery>, options: { resetCatalog?: boolean; activeFilterId?: string | undefined } = {}): Promise<void> {
    this.#set({
      query: { ...this.state.query, ...query },
      activeFilterId: options.activeFilterId,
      ...(options.resetCatalog ? { statusCatalog: [] } : {}),
    });
    this.#remember();
    return this.search();
  }

  #remember(): void {
    const { query, mode } = this.state;
    if (query.preset !== "custom") this.#lastPreset = query.preset;
    writeJiraBrowserPreference(this.projectId, {
      preset: this.#lastPreset,
      jiraProjectKey: query.jiraProjectKey,
      statuses: query.statuses,
      currentSprint: query.currentSprint,
      mode,
    }, this.storage);
  }

  setPreset(preset: JiraPreset): Promise<void> {
    return this.#update({ preset, jql: "", text: "" }, { resetCatalog: preset !== this.state.query.preset });
  }

  async setProjectKey(jiraProjectKey: string | null): Promise<void> {
    await Promise.all([this.#update({ jiraProjectKey, statuses: [] }, { resetCatalog: true }), this.#loadStatuses()]);
  }

  toggleStatus(name: string): Promise<void> {
    const statuses = this.state.query.statuses;
    return this.#update({ statuses: statuses.includes(name) ? statuses.filter((status) => status !== name) : [...statuses, name] });
  }

  clearStatuses(): Promise<void> {
    return this.#update({ statuses: [] });
  }

  setCurrentSprint(currentSprint: boolean): Promise<void> {
    return this.#update({ currentSprint });
  }

  setText(text: string): Promise<void> {
    if (text.trim() === this.state.query.text.trim()) return Promise.resolve();
    return this.#update({ text });
  }

  /** Runs JQL as written (preset `custom`). */
  runJql(jql: string, activeFilterId?: string): Promise<void> {
    const trimmed = jql.trim();
    if (!trimmed) return Promise.resolve();
    return this.#update({ preset: "custom", jql: trimmed, text: "" }, { activeFilterId });
  }

  applyFilter(filter: { id: string; jql: string }): Promise<void> {
    return this.runJql(filter.jql, filter.id);
  }

  setMode(mode: JiraViewMode): void {
    this.#set({ mode });
    this.#remember();
  }

  /** Saves (creates, or renames/replaces by id) a local filter; returns why it was refused. */
  saveFilter(filter: { id?: string; name: string; jql: string }): string | undefined {
    const next = saveFilter(this.state.savedFilters, { id: filter.id ?? crypto.randomUUID(), name: filter.name, jql: filter.jql });
    if ("error" in next) return next.error;
    this.#set({ savedFilters: next });
    writeSavedFilters(next, this.storage);
    return undefined;
  }

  deleteFilter(id: string): void {
    const savedFilters = this.state.savedFilters.filter((filter) => filter.id !== id);
    this.#set({ savedFilters, activeFilterId: this.state.activeFilterId === id ? undefined : this.state.activeFilterId });
    writeSavedFilters(savedFilters, this.storage);
  }

  /** Creates a PM ticket linked to the issue and marks the row as linked, without another Jira read. */
  async addToPm(issue: PmJiraIssue): Promise<void> {
    if (issue.pmTicketId || this.state.adding.includes(issue.key)) return;
    this.#set({ adding: [...this.state.adding, issue.key] });
    try {
      const ticketId = await this.addIssueToPm(issue);
      const result = this.state.result;
      if (ticketId && result) {
        this.#set({ result: { ...result, issues: result.issues.map((item) => (item.key === issue.key ? { ...item, pmTicketId: ticketId } : item)) } });
      }
    } finally {
      this.#set({ adding: this.state.adding.filter((key) => key !== issue.key) });
    }
  }
}
