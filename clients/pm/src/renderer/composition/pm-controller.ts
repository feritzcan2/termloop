// The renderer's wiring seam: turns UI intents into allowlisted `window.pm`
// calls and rereads into the store. React-free so it is testable with a fake
// bridge. Nothing here writes to Jira or GitHub unless the PM asked for it.
import type {
  MethodParams,
  MethodResults,
  PmAssistantTask,
  PmEnvironment,
  PmProbeMatcher,
  PmProposal,
  PmSettingsUpdateParams,
  PmSkillSetup,
  PmTicket,
  PmTicketCreateParams,
  PmTicketStatus,
  PmTicketUpdateParams,
} from "@termloop/pm-contract/pm";
import type { PmApi, PmEvent, RendererMethod } from "../../pm-api.js";
import type { PmState, PmStore, PmView } from "../state/presentation-store.js";
import { touchesJira } from "../ui/proposal-change.js";
import type { NoteDraft } from "../ui/NoteDialog.js";
import type { DescriptionSaveOutcome, TicketCapture } from "../ui/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type JiraSourceInput = { siteUrl: string; boardId: number | null; accountEmail: string; token: string };
export type GitHubSourceInput = { owner: string; name: string } | null;

export class PmController {
  #unsubscribers: (() => void)[] = [];
  #boardRead: Promise<void> | undefined;
  #boardStale = false;
  /** The stage content the Jira browser replaced; toggling Jira off returns to it. */
  #beforeJira: PmView = "overview";

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
    if (view === "jira" && this.state.view !== "jira") this.#beforeJira = this.state.view;
    this.#set({ view });
    if (view === "settings") void this.loadSettings();
  }

  /** The activity bar's Jira item: shows the Jira browser in the stage, or returns to what it replaced. */
  toggleJiraStage(): void {
    this.setView(this.state.view === "jira" ? this.#beforeJira : "jira");
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
    else if (event.event === "pmSkillsChanged") void this.loadSkills();
    else void this.refreshBoard();
    const selected = this.state.selectedTicketId;
    if (event.event === "pmBoardChanged" && selected) void Promise.all([this.loadProposals(selected), this.loadNotes(selected)]);
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

  /** Sets or clears the code folder the project's agents start in. */
  async setProjectFolder(folder: string | null): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const project = await this.call("pm_project_update", { projectId, folder });
    if (!project) return;
    this.#set({ projects: this.state.projects.map((candidate) => candidate.id === project.id ? project : candidate) });
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
      notes: {},
      agents: [],
      activeAgentSessionId: undefined,
      sources: undefined,
      skills: undefined,
      suggestions: undefined,
      view: this.state.view === "ticket" || this.state.view === "agent" ? "overview" : this.state.view,
    });
    await this.refreshProject();
  }

  async refreshProject(): Promise<void> {
    await Promise.all([this.refreshBoard(), this.refreshAgents(), this.loadSources(), this.loadSkills()]);
  }

  /**
   * Coalesces concurrent rereads into one in flight plus one trailing read.
   * The digest and the skill suggestions are reread beside the board: every
   * board change may add an entry to "since yesterday" or a suggestion.
   */
  refreshBoard(): Promise<void> {
    if (this.#boardRead) {
      this.#boardStale = true;
      return this.#boardRead;
    }
    this.#boardRead = (async () => {
      do {
        this.#boardStale = false;
        await Promise.all([this.#readBoard(), this.refreshDigest(), this.loadSuggestions()]);
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
    await Promise.all([this.loadProposals(ticketId), this.loadNotes(ticketId)]);
  }

  /**
   * Creates a ticket in `sprintId` (the focused sprint by default, the backlog
   * for `null`) and opens it unless `open` is false.
   */
  async createTicket(
    title: string,
    sprintId: string | null | undefined = this.state.selectedSprintId,
    fields: Pick<PmTicketCreateParams, "priority" | "assignee" | "jiraUrl"> = {},
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
    if (ticket && capture.askAssistant) await this.launchAgent(ticket.id, false);
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

  async loadNotes(ticketId: string): Promise<void> {
    const result = await this.call("pm_ticket_notes_read", { ticketId });
    if (result) this.#set({ notes: { ...this.state.notes, [ticketId]: result.notes } });
  }

  /** Records what the PM learned; the description changes only through a draft the PM applies. */
  async addNote(ticketId: string, draft: NoteDraft): Promise<boolean> {
    const note = await this.call("pm_ticket_note_add", { ticketId, kind: draft.kind, text: draft.text, ...(draft.url ? { url: draft.url } : {}) });
    if (!note) return false;
    await this.loadNotes(ticketId);
    return true;
  }

  async removeNote(ticketId: string, noteId: string): Promise<void> {
    await this.call("pm_ticket_note_remove", { noteId });
    await this.loadNotes(ticketId);
  }

  /**
   * Starts an assistant that reads the ticket's notes and followed sources
   * and drafts one description from them; the draft waits for the PM.
   */
  async updateDescription(ticketId: string): Promise<void> {
    await this.launchAgent(ticketId, true, "updateDescription");
  }

  async loadSuggestions(): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const result = await this.call("pm_skill_suggestions_read", { projectId });
    if (result && this.state.projectId === projectId) this.#set({ suggestions: result.proposals });
  }

  #proposal(ticketId: string, proposalId: string): PmProposal | undefined {
    return [...(this.state.proposals[ticketId] ?? []), ...(this.state.suggestions ?? [])].find((candidate) => candidate.id === proposalId);
  }

  async loadProposals(ticketId: string): Promise<void> {
    const result = await this.call("pm_ticket_proposals_read", { ticketId });
    if (result) this.#set({ proposals: { ...this.state.proposals, [ticketId]: result.proposals } });
  }

  /**
   * Applies a draft to the PM ticket. A change Jira should also see opens
   * the "Write to Jira" diff, where the PM confirms the external write.
   */
  async acceptProposal(ticketId: string, proposalId: string, assignee?: string): Promise<void> {
    await this.#accept(ticketId, [this.#proposal(ticketId, proposalId) ?? { id: proposalId }], assignee);
  }

  /**
   * Accepts every skill suggestion for a ticket in order, each with its
   * proposed value, and stops at the first refusal.
   */
  async acceptAllSuggestions(ticketId: string): Promise<void> {
    await this.#accept(ticketId, (this.state.suggestions ?? []).filter((proposal) => proposal.ticketId === ticketId));
  }

  /** Accepts in order until a refusal; the Jira diff opens once if any accepted change touches Jira. */
  async #accept(ticketId: string, proposals: (Pick<PmProposal, "id"> & Partial<PmProposal>)[], assignee?: string): Promise<void> {
    let ticket: PmTicket | undefined;
    let jira = false;
    for (const proposal of proposals) {
      const accepted = await this.call("pm_ticket_proposal_accept", { proposalId: proposal.id, ...(assignee ? { assignee } : {}) });
      if (!accepted) break;
      ticket = accepted;
      jira ||= proposal.change !== undefined && touchesJira(proposal.change);
    }
    await Promise.all([this.loadProposals(ticketId), this.refreshBoard()]);
    if (jira && ticket?.jiraUrl) await this.openJiraDialog(ticketId);
  }

  async rejectProposal(ticketId: string, proposalId: string, reason?: string): Promise<void> {
    await this.call("pm_ticket_proposal_reject", { proposalId, ...(reason ? { reason } : {}) });
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
    // With no agent left to show, the stage returns to the ticket or overview.
    const view = this.state.view === "agent" && !active ? (this.state.selectedTicketId ? "ticket" : "overview") : this.state.view;
    this.#set({ agents: live, activeAgentSessionId: active, view });
  }

  /** Starts an assistant and shows it in the stage unless `open` is false. */
  async launchAgent(focusTicketId: string | undefined, open = true, task?: PmAssistantTask): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const session = await this.call("pm_agent_launch", { projectId, ...(focusTicketId ? { focusTicketId } : {}), ...(task ? { task } : {}) });
    if (!session) return;
    this.#set(open ? { activeAgentSessionId: session.sessionId, view: "agent" } : { activeAgentSessionId: session.sessionId });
    await this.refreshAgents();
  }

  async stopAgent(sessionId: string): Promise<void> {
    await this.call("pm_agent_stop", { sessionId });
    await this.refreshAgents();
  }

  /** Shows an agent's terminal in place of the stage's current content. */
  selectAgent(sessionId: string): void {
    this.#set({ activeAgentSessionId: sessionId, view: "agent" });
  }

  // Skills -----------------------------------------------------------------
  // Skill changes reach `skills` through the daemon's pmSkillsChanged event.

  async loadSkills(): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const skills = await this.call("pm_skills_read", { projectId });
    if (skills && this.state.projectId === projectId) this.#set({ skills });
  }

  async setSkillEnabled(skillId: string, enabled: boolean): Promise<void> {
    await this.call("pm_skill_set_enabled", { skillId, enabled });
  }

  /**
   * A skill row's Set up opens that skill's own creator. Deployment control
   * turns on directly when the project already lists its environments.
   */
  async setUpSkill(kind: PmSkillSetup): Promise<void> {
    const builtin = this.state.skills?.skills.find((skill) => skill.builtin === "deploymentControl");
    if (kind === "deploymentControl" && builtin) return this.setSkillEnabled(builtin.id, true);
    return this.launchSkillCreator({ setup: kind });
  }

  /** Lists the environments and approves the probes the PM ticked; Deployment control turns on. */
  async applyEnvironmentProposal(environments: string[], probeIds: string[]): Promise<boolean> {
    const projectId = this.state.projectId;
    if (!projectId) return false;
    const applied = await this.call("pm_environment_proposal_apply", { projectId, environments, probeIds });
    if (!applied) return false;
    this.#set({ notice: { tone: "info", text: "Deployment control is on." } });
    return true;
  }

  async discardEnvironmentProposal(): Promise<void> {
    const projectId = this.state.projectId;
    if (projectId) await this.call("pm_environment_proposal_discard", { projectId });
  }

  /** Runs a skill now; a run with nothing new says so instead of starting an agent. */
  async runSkill(skillId: string): Promise<void> {
    const result = await this.call("pm_skill_run", { skillId });
    if (!result) return;
    const name = result.skill.manifest.name;
    const text = result.run === null
      ? `${name}: ${result.checksStarted} check(s) started.`
      : result.run.outcome === "skipped"
        ? `${name}: nothing new since the last run.`
        : `${name} is running.`;
    this.#set({ notice: { tone: "info", text } });
    await Promise.all([this.loadSkills(), this.refreshAgents()]);
  }

  /**
   * Starts the skill creator and shows it in the stage: one that offers
   * skills, one skill's own setup creator, or one that revises a skill.
   */
  async launchSkillCreator(target: { setup: PmSkillSetup } | { skillId: string } | {} = {}): Promise<void> {
    const projectId = this.state.projectId;
    if (!projectId) return;
    const session = await this.call("pm_skill_creator_launch", { projectId, ...target });
    if (!session) return;
    this.selectAgent(session.sessionId);
    await this.refreshAgents();
  }

  async dryRunDraft(draftId: string): Promise<void> {
    if (await this.call("pm_skill_draft_dry_run", { draftId })) await this.refreshAgents();
  }

  async discardDraft(draftId: string): Promise<void> {
    await this.call("pm_skill_draft_discard", { draftId });
  }

  /** Installs a dry-run draft with the first-use tools the PM ticked; the daemon refuses any left unticked. */
  async installDraft(draftId: string, approvedTools: string[], channels?: string[]): Promise<boolean> {
    const skill = await this.call("pm_skill_install", { draftId, approvedTools, ...(channels ? { channels } : {}) });
    if (!skill) return false;
    this.#set({ notice: { tone: "info", text: `${skill.manifest.name} installed.` } });
    return true;
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
