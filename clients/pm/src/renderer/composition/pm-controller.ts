// The renderer's wiring seam: turns UI intents into allowlisted `window.pm`
// calls and rereads into the store. React-free so it is testable with a fake
// bridge. Nothing here writes to Jira or GitHub unless the PM asked for it.
import type {
  MethodParams,
  MethodResults,
  PmEnvironment,
  PmProbeMatcher,
  PmSettingsUpdateParams,
  PmTicket,
  PmTicketCreateParams,
  PmTicketStatus,
  PmTicketUpdateParams,
} from "@termloop/pm-contract/pm";
import type { PmApi, PmEvent, RendererMethod } from "../../pm-api.js";
import type { PmState, PmStore, PmView } from "../state/presentation-store.js";
import type { DescriptionSaveOutcome, TicketCapture } from "../ui/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type JiraSourceInput = { siteUrl: string; boardId: number | null; accountEmail: string; token: string };
export type GitHubSourceInput = { owner: string; name: string } | null;

export class PmController {
  #unsubscribers: (() => void)[] = [];
  #boardRead: Promise<void> | undefined;
  #boardStale = false;

  constructor(readonly bridge: PmApi, readonly store: PmStore, readonly now: () => number = Date.now) {}

  get state(): PmState {
    return this.store.getState();
  }

  #set(patch: Partial<PmState>): void {
    this.store.setState(patch);
  }

  /** Calls one method; a failure becomes a visible notice and `undefined`. */
  async call<M extends RendererMethod>(method: M, params: MethodParams[M]): Promise<MethodResults[M] | undefined> {
    const outcome = await this.bridge.call(method, params);
    if (outcome.ok) return outcome.result;
    this.#set({ notice: { tone: "error", text: outcome.error.message } });
    return undefined;
  }

  async start(): Promise<void> {
    this.#unsubscribers.push(
      this.bridge.onConnectionState((connection) => {
        this.#set({ connection });
        if (connection.state === "connected") void this.loadProjects();
      }),
      this.bridge.onEvent((event) => this.handleEvent(event)),
    );
    const connection = await this.bridge.connectionState();
    this.#set({ connection });
    if (connection.state === "connected") await this.loadProjects();
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  setView(view: PmView): void {
    this.#set({ view });
    if (view === "settings") void this.loadSettings();
  }

  handleEvent(event: PmEvent): void {
    const projectId = this.state.projectId;
    const payload = event.payload as { projectId?: string };
    if (event.event === "pmResubscribed") {
      if (projectId) void this.refreshProject();
      return;
    }
    if (!projectId || payload.projectId !== projectId) return;
    if (event.event === "pmAgentChanged") void this.refreshAgents();
    else void this.refreshBoard();
    if (event.event === "pmBoardChanged" && this.state.selectedTicketId) void this.loadProposals(this.state.selectedTicketId);
  }

  // Projects ---------------------------------------------------------------

  async loadProjects(): Promise<void> {
    const result = await this.call("pm_project_list", {});
    if (!result) return;
    const current = this.state.projectId;
    const projectId = result.projects.some((project) => project.id === current) ? current : result.projects[0]?.id;
    this.#set({ projects: result.projects });
    if (projectId && projectId !== current) await this.selectProject(projectId);
  }

  async createProject(name: string): Promise<void> {
    const project = await this.call("pm_project_create", { name });
    if (!project) return;
    this.#set({ projects: [...this.state.projects, project] });
    await this.selectProject(project.id);
  }

  async selectProject(projectId: string): Promise<void> {
    this.#set({
      projectId,
      board: undefined,
      digest: undefined,
      selectedSprintId: undefined,
      selectedTicketId: undefined,
      proposals: {},
      versions: {},
      agents: [],
      activeAgentSessionId: undefined,
      sources: undefined,
      view: this.state.view === "ticket" ? "overview" : this.state.view,
    });
    await this.refreshProject();
  }

  async refreshProject(): Promise<void> {
    await Promise.all([this.refreshBoard(), this.refreshAgents(), this.loadSources()]);
  }

  /**
   * Coalesces concurrent rereads into one in flight plus one trailing read.
   * The digest is reread beside the board: every board change may add an
   * entry to "since yesterday".
   */
  refreshBoard(): Promise<void> {
    if (this.#boardRead) {
      this.#boardStale = true;
      return this.#boardRead;
    }
    this.#boardRead = (async () => {
      do {
        this.#boardStale = false;
        await Promise.all([this.#readBoard(), this.refreshDigest()]);
      } while (this.#boardStale);
    })().finally(() => { this.#boardRead = undefined; });
    return this.#boardRead;
  }

  async #readBoard(): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const board = await this.call("pm_board_read", { projectId });
    if (!board || this.state.projectId !== projectId) return;
    const selected = this.state.selectedSprintId;
    const sprintId = board.sprints.some((sprint) => sprint.id === selected)
      ? selected
      : (board.sprints.find((sprint) => sprint.state === "active") ?? board.sprints[0])?.id;
    this.#set({ board, selectedSprintId: sprintId });
  }

  async refreshDigest(): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const digest = await this.call("pm_digest_read", { projectId, sinceEpochMs: Math.max(0, this.now() - DAY_MS) });
    if (digest && this.state.projectId === projectId) this.#set({ digest });
  }

  // Sprints ----------------------------------------------------------------

  selectSprint(sprintId: string): void {
    this.#set({ selectedSprintId: sprintId, view: "overview", selectedTicketId: undefined });
  }

  async createSprint(name: string, goal: string): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId || !name.trim()) return;
    const sprint = await this.call("pm_sprint_create", {
      projectId,
      name: name.trim(),
      ...(goal.trim() ? { goal: goal.trim() } : {}),
      state: "planned",
    });
    if (!sprint) return;
    this.#set({ selectedSprintId: sprint.id });
    await this.refreshBoard();
  }

  async activateSprint(sprintId: string): Promise<void> {
    if (await this.call("pm_sprint_activate", { sprintId })) await this.refreshBoard();
  }

  async closeSprint(sprintId: string, carryOverTo: string | undefined): Promise<void> {
    const result = await this.call("pm_sprint_close", { sprintId, ...(carryOverTo ? { carryOverTo } : {}) });
    if (!result) return;
    this.#set({
      notice: { tone: "info", text: `${result.sprint.name} closed; ${result.carriedOverTicketIds.length} ticket(s) carried over.` },
    });
    await this.refreshBoard();
  }

  // Tickets ----------------------------------------------------------------

  async selectTicket(ticketId: string): Promise<void> {
    this.#set({ selectedTicketId: ticketId, view: "ticket" });
    await this.loadProposals(ticketId);
  }

  /**
   * Creates a ticket in `sprintId` (the focused sprint by default, the backlog
   * for `null`) and opens it unless `open` is false.
   */
  async createTicket(
    title: string,
    sprintId: string | null | undefined = this.state.selectedSprintId,
    fields: Pick<PmTicketCreateParams, "priority" | "assignee"> = {},
    open = true,
  ): Promise<PmTicket | undefined> {
    const projectId = this.state.projectId;
    if (!projectId || !title.trim()) return undefined;
    const ticket = await this.call("pm_ticket_create", { projectId, title: title.trim(), ...(sprintId ? { sprintId } : {}), ...fields });
    if (!ticket) return undefined;
    await this.refreshBoard();
    if (open) await this.selectTicket(ticket.id);
    return ticket;
  }

  /**
   * Files a ticket without leaving the current view. When asked, an assistant
   * focused on it starts the same way "Ask assistant" does; whatever it drafts
   * arrives as a proposal the PM reviews.
   */
  async captureTicket(capture: TicketCapture): Promise<PmTicket | undefined> {
    const assignee = capture.assignee.trim();
    const ticket = await this.createTicket(capture.title, capture.sprintId, { priority: capture.priority, ...(assignee ? { assignee } : {}) }, false);
    if (ticket && capture.askAssistant) await this.launchAgent(ticket.id);
    return ticket;
  }

  async updateTicket(ticketId: string, fields: Omit<PmTicketUpdateParams, "ticketId">): Promise<void> {
    if (await this.call("pm_ticket_update", { ticketId, ...fields })) await this.refreshBoard();
  }

  async setStatus(ticketId: string, status: PmTicketStatus): Promise<void> {
    await this.updateTicket(ticketId, { status });
  }

  /** Moves a ticket to a lane (a sprint, or the backlog for `null`), at `index` within it when given. */
  async moveTicket(ticketId: string, sprintId: string | null, index?: number): Promise<void> {
    const params = index === undefined ? { ticketId, sprintId } : { ticketId, sprintId, index };
    if (await this.call("pm_ticket_move", params)) await this.refreshBoard();
  }

  /** Saves on `baseVersion`; a newer saved version makes it a `conflict`, shown in the editor rather than as a notice. */
  async saveDescription(ticketId: string, description: string, baseVersion: number): Promise<DescriptionSaveOutcome> {
    const outcome = await this.bridge.call("pm_ticket_description_save", { ticketId, description, baseVersion });
    if (!outcome.ok && outcome.error.code === "conflict") {
      await this.refreshBoard();
      return { kind: "conflict" };
    }
    if (!outcome.ok) {
      this.#set({ notice: { tone: "error", text: outcome.error.message } });
      return { kind: "failed" };
    }
    await this.refreshBoard();
    if (this.state.versions[ticketId]) await this.loadVersions(ticketId);
    return { kind: "saved", headVersion: outcome.result.versions?.headNumber ?? baseVersion + 1 };
  }

  async loadVersions(ticketId: string): Promise<void> {
    const result = await this.call("pm_ticket_versions_read", { ticketId });
    if (result) this.#set({ versions: { ...this.state.versions, [ticketId]: result.versions } });
  }

  async addCriterion(ticketId: string, text: string): Promise<void> {
    if (text.trim() && await this.call("pm_ticket_criterion_add", { ticketId, text: text.trim() })) await this.refreshBoard();
  }

  async setCriterionDone(ticketId: string, criterionId: string, done: boolean): Promise<void> {
    if (await this.call("pm_ticket_criterion_set_done", { ticketId, criterionId, done })) await this.refreshBoard();
  }

  async removeCriterion(ticketId: string, criterionId: string): Promise<void> {
    if (await this.call("pm_ticket_criterion_remove", { ticketId, criterionId })) await this.refreshBoard();
  }

  async addBlocker(ticketId: string, text: string): Promise<void> {
    if (text.trim() && await this.call("pm_ticket_blocker_add", { ticketId, text: text.trim() })) await this.refreshBoard();
  }

  async removeBlocker(ticketId: string, blockerId: string): Promise<void> {
    if (await this.call("pm_ticket_blocker_remove", { ticketId, blockerId })) await this.refreshBoard();
  }

  async loadProposals(ticketId: string): Promise<void> {
    const result = await this.call("pm_ticket_proposals_read", { ticketId });
    if (result) this.#set({ proposals: { ...this.state.proposals, [ticketId]: result.proposals } });
  }

  async acceptProposal(ticketId: string, proposalId: string): Promise<void> {
    const ticket = await this.call("pm_ticket_proposal_accept", { proposalId });
    await this.loadProposals(ticketId);
    if (ticket) await this.refreshBoard();
  }

  async rejectProposal(ticketId: string, proposalId: string): Promise<void> {
    await this.call("pm_ticket_proposal_reject", { proposalId });
    await this.loadProposals(ticketId);
    await this.refreshBoard();
  }

  async startCheck(ticketId: string): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const result = await this.call("pm_check_start", { projectId, ticketIds: [ticketId] });
    const refusal = result?.refused[0];
    if (refusal) this.#set({ notice: { tone: "error", text: `Check not started: ${refusal.reason}.` } });
    await Promise.all([this.refreshBoard(), this.refreshAgents()]);
  }

  // Jira -------------------------------------------------------------------

  async pullJira(): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId || this.state.pulling) return;
    this.#set({ pulling: true });
    try {
      const result = await this.call("pm_jira_pull", { projectId });
      if (result) this.#set({ lastPull: result, notice: pullNotice(result.outcome) });
      await this.refreshBoard();
    } finally {
      this.#set({ pulling: false });
    }
  }

  async openJiraDialog(ticketId: string): Promise<void> {
    this.#set({ jiraDialog: { ticketId, loading: true, diff: undefined, staleNotice: false, result: undefined, error: undefined } });
    const outcome = await this.bridge.call("pm_jira_diff_read", { ticketId });
    const dialog = this.state.jiraDialog;
    if (dialog?.ticketId !== ticketId) return;
    this.#set({
      jiraDialog: outcome.ok
        ? { ...dialog, loading: false, diff: outcome.result }
        : { ...dialog, loading: false, error: outcome.error.message },
    });
  }

  /** Sends the PM-approved diff token; a stale token shows Jira's new diff instead. */
  async applyJira(): Promise<void> {
    const dialog = this.state.jiraDialog;
    if (!dialog?.diff || dialog.loading) return;
    this.#set({ jiraDialog: { ...dialog, loading: true, error: undefined } });
    const outcome = await this.bridge.call("pm_jira_apply", { ticketId: dialog.ticketId, token: dialog.diff.token });
    const current = this.state.jiraDialog;
    if (current?.ticketId !== dialog.ticketId) return;
    if (!outcome.ok) {
      this.#set({ jiraDialog: { ...current, loading: false, error: outcome.error.message } });
      return;
    }
    const result = outcome.result;
    if (result.kind === "stale") {
      this.#set({ jiraDialog: { ...current, loading: false, diff: result.diff, staleNotice: true } });
      return;
    }
    this.#set({ jiraDialog: { ...current, loading: false, staleNotice: false, result } });
    await this.refreshBoard();
  }

  closeJiraDialog(): void {
    this.#set({ jiraDialog: undefined });
  }

  // Agents -----------------------------------------------------------------

  async refreshAgents(): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const result = await this.call("pm_agent_list", { projectId });
    if (!result || this.state.projectId !== projectId) return;
    const live = result.sessions.filter((session) => session.state !== "exited");
    const active = live.some((session) => session.sessionId === this.state.activeAgentSessionId)
      ? this.state.activeAgentSessionId
      : live[0]?.sessionId;
    this.#set({ agents: live, activeAgentSessionId: active });
  }

  async launchAgent(focusTicketId: string | undefined): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const session = await this.call("pm_agent_launch", { projectId, ...(focusTicketId ? { focusTicketId } : {}) });
    if (!session) return;
    this.#set({ activeAgentSessionId: session.sessionId });
    await this.refreshAgents();
  }

  async stopAgent(sessionId: string): Promise<void> {
    await this.call("pm_agent_stop", { sessionId });
    await this.refreshAgents();
  }

  selectAgent(sessionId: string): void {
    this.#set({ activeAgentSessionId: sessionId });
  }

  // Settings ---------------------------------------------------------------

  async loadSettings(): Promise<void> {
    const [settings, catalog] = await Promise.all([
      this.call("pm_settings_read", {}),
      this.state.catalog ? Promise.resolve(this.state.catalog) : this.call("pm_agent_catalog_read", {}),
    ]);
    if (settings) this.#set({ settings });
    if (catalog) this.#set({ catalog });
    await this.loadSources();
  }

  async loadSources(): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const sources = await this.call("pm_sources_read", { projectId });
    if (sources && this.state.projectId === projectId) this.#set({ sources });
  }

  async saveSettings(edit: PmSettingsUpdateParams): Promise<void> {
    const settings = await this.call("pm_settings_update", edit);
    if (settings) this.#set({ settings, notice: { tone: "info", text: "Agent settings saved." } });
  }

  /**
   * Saves the Jira and GitHub sources. A typed token is stored first in the
   * daemon's credential store; only its handle reaches the sources record.
   */
  async saveSources(jira: JiraSourceInput | null, github: GitHubSourceInput): Promise<boolean> {
    const projectId = this.state.projectId;
    if (!projectId) return false;
    let jiraSource: MethodParams["pm_sources_set"]["jira"] = null;
    if (jira) {
      let credentialHandle = this.state.sources?.jira?.credentialHandle;
      if (jira.token) {
        const stored = await this.call("pm_credential_store", { kind: "jiraApiToken", secret: jira.token });
        if (!stored) return false;
        credentialHandle = stored.credentialHandle;
      }
      if (!credentialHandle) {
        this.#set({ notice: { tone: "error", text: "Enter a Jira API token to connect Jira." } });
        return false;
      }
      jiraSource = { siteUrl: jira.siteUrl, boardId: jira.boardId, accountEmail: jira.accountEmail, credentialHandle };
    }
    const sources = await this.call("pm_sources_set", { projectId, jira: jiraSource, github });
    if (!sources) return false;
    this.#set({ sources, notice: { tone: "info", text: "Sources saved." } });
    await this.refreshBoard();
    return true;
  }

  async clearJiraToken(): Promise<void> {
    const handle = this.state.sources?.jira?.credentialHandle;
    if (!handle) return;
    if (await this.call("pm_credential_clear", { credentialHandle: handle })) {
      this.#set({ notice: { tone: "info", text: "Jira token removed from the credential store." } });
    }
  }

  async setEnvironments(environments: PmEnvironment[]): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    if (await this.call("pm_environments_set", { projectId, environments })) await this.refreshBoard();
  }

  async createProbe(environment: string, argv: string[], matcher: PmProbeMatcher): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId || argv.length === 0) return;
    if (await this.call("pm_probe_create", { projectId, environment, argv, matcher })) await this.refreshBoard();
  }

  async approveProbe(probeId: string): Promise<void> {
    if (await this.call("pm_probe_approve", { probeId })) await this.refreshBoard();
  }

  async rejectProbe(probeId: string): Promise<void> {
    if (await this.call("pm_probe_reject", { probeId })) await this.refreshBoard();
  }

  async deleteProbe(probeId: string): Promise<void> {
    if (await this.call("pm_probe_delete", { probeId })) await this.refreshBoard();
  }
}

function pullNotice(outcome: MethodResults["pm_jira_pull"]["outcome"]): PmState["notice"] {
  switch (outcome.kind) {
    case "applied":
      return {
        tone: "info",
        text: `Jira pulled: ${outcome.ticketsCreated.length} new, ${outcome.ticketsMoved.length} moved, ${outcome.sprintsCreated.length} sprint(s) added.`,
      };
    case "stale":
      return { tone: "info", text: "Jira changed during the pull; pull again." };
    case "sprintsUnsupported":
      return { tone: "error", text: "This Jira board has no sprints." };
    case "failed":
      return { tone: "error", text: `Jira pull failed: ${outcome.reason}.` };
  }
}
