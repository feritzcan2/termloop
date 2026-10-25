// Composition: binds store state to UI props and UI intents to the
// controller. The only renderer layer that sees both the bridge-backed
// controller and the terminal adapter.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PmAgentSession, PmBoardTicket, PmSkill, PmTicketNoteKind } from "@termloop/pm-contract/pm";
import type { PmApi } from "../../pm-api.js";
import { usePmState, type PmState } from "../state/presentation-store.js";
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  clampLeftSidebarWidth,
  fitSidebarWidths,
  readLeftSidebarPreference,
  writeLeftSidebarPreference,
} from "../state/left-sidebar-preference.js";
import {
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  clampRightSidebarWidth,
  readRightSidebarPreference,
  toggleRightSidebar,
  writeRightSidebarPreference,
  type RightSidebarPreference,
} from "../state/right-sidebar-preference.js";
import { mountAgentTerminal } from "../terminal/agent-terminal.js";
import { agentSurface } from "../terminal/xterm-surface.js";
import { AgentPanel } from "../ui/AgentPanel.js";
import { JiraSyncDialog } from "../ui/JiraSyncDialog.js";
import { NoteDialog } from "../ui/NoteDialog.js";
import type { ContextMenuItem } from "../ui/TicketContextMenu.js";
import type { JiraConnection } from "../ui/jira/JiraBrowser.js";
import { CaptureToast, QuickCapture } from "../ui/QuickCapture.js";
import type { WidthBounds } from "../ui/ResizeHandle.js";
import { RightActivityBar } from "../ui/RightActivityBar.js";
import { RightSidebar } from "../ui/RightSidebar.js";
import { SettingsPage } from "../ui/SettingsPage.js";
import { SkillsPanel } from "../ui/SkillsPanel.js";
import { SuggestionsPanel } from "../ui/SuggestionsPanel.js";
import { Sidebar } from "../ui/Sidebar.js";
import { SprintOverview } from "../ui/SprintOverview.js";
import { SprintsPanel } from "../ui/SprintsPanel.js";
import { SprintDnd } from "../ui/sprint-dnd.js";
import { StageTabs, type StageTab } from "../ui/StageTabs.js";
import { TicketEditor } from "../ui/TicketEditor.js";
import { lastJiraPull, leftSprint, sprintTickets, ticketLabel } from "../ui/format.js";
import type { AgentTab, MountTerminal, TicketCapture } from "../ui/types.js";
import { DoubleShiftDetector, isNewTicketShortcut } from "./capture-shortcut.js";
import { JiraStage } from "./JiraStage.js";
import type { PmController } from "./pm-controller.js";

const EMPTY: never[] = [];
const LEFT_BOUNDS: WidthBounds = { min: LEFT_SIDEBAR_MIN_WIDTH, max: LEFT_SIDEBAR_MAX_WIDTH, defaultWidth: LEFT_SIDEBAR_DEFAULT_WIDTH };
const RIGHT_BOUNDS: WidthBounds = { min: RIGHT_SIDEBAR_MIN_WIDTH, max: RIGHT_SIDEBAR_MAX_WIDTH, defaultWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH };
const CAPTURE_TOAST_MS = 6000;

export function PmApp({ controller, terminal }: { controller: PmController; terminal: PmApi["terminal"] | undefined }) {
  const store = controller.store;
  const state = usePmState(store, (value) => value);
  const now = useNow();
  useEffect(() => {
    void controller.start();
    return () => controller.dispose();
  }, [controller]);
  const mountTerminal = useCallback<MountTerminal>(
    (host, sessionId) => (terminal ? mountAgentTerminal(terminal, host, sessionId, agentSurface) : () => undefined),
    [terminal],
  );

  if (state.connection.state !== "connected") return <ConnectionScreen connection={state.connection} />;
  return <Workspace controller={controller} state={state} now={now} mountTerminal={mountTerminal} />;
}

function Workspace({ controller, state, now, mountTerminal }: { controller: PmController; state: PmState; now: number; mountTerminal: MountTerminal }) {
  const board = state.board;
  const tier = board?.tracking.tier ?? "tickets";
  const sprints = board?.sprints ?? EMPTY;
  const allTickets = board?.tickets ?? EMPTY;
  const tickets = useMemo(() => sprintTickets(allTickets, state.selectedSprintId), [allTickets, state.selectedSprintId]);
  const sprint = sprints.find((candidate) => candidate.id === state.selectedSprintId);
  const entry = allTickets.find((candidate) => candidate.ticket.id === state.selectedTicketId);
  const project = state.projects.find((candidate) => candidate.id === state.projectId);
  const jiraConfigured = Boolean(state.sources?.jira) || Boolean(board?.tracking.jira);
  const jiraConnection: JiraConnection = state.sources === undefined ? "checking" : state.sources.jira ? "connected" : "notConnected";
  const agents: AgentTab[] = state.agents.map((session) => ({
    sessionId: session.sessionId,
    state: session.state,
    assistant: session.mode === "assistant" || session.mode === "skillCreator",
    provider: session.provider,
    label: agentLabel(session, allTickets, state.skills?.skills ?? EMPTY),
    detail: session.mode === "assistant"
      ? (session.focusTicketId ? checkLabel(allTickets, session.focusTicketId) : sprint?.name.toLowerCase() ?? "project")
      : session.mode === "deliveryCheck" ? "delivery check" : "skill",
    focusTicketId: session.focusTicketId,
  }));
  const activeAgent = agents.find((agent) => agent.sessionId === state.activeAgentSessionId);
  const ticketsOnly = useMemo(() => allTickets.map((candidate) => candidate.ticket), [allTickets]);
  const ticketId = entry?.ticket.id;
  const view = (state.view === "ticket" && !entry) || (state.view === "agent" && !activeAgent) ? "overview" : state.view;
  const shownSprintId = leftSprint(sprints, state.selectedSprintId)?.id;
  const lane = useMemo(() => (shownSprintId ? sprintTickets(allTickets, shownSprintId) : EMPTY), [allTickets, shownSprintId]);
  const [right, updateRight] = useRightSidebar();
  const [leftWidth, setLeftWidth] = useLeftSidebarWidth();
  const viewport = useViewportWidth();
  const fitted = fitSidebarWidths(leftWidth, right.open ? right.width : undefined, viewport);
  useNudgeNativeSurfaces(fitted.left);
  const [capturing, setCapturing] = useState(false);
  useCaptureShortcut(controller, Boolean(project) && !state.jiraDialog, () => setCapturing(true));
  const [created, setCreated] = useState<{ id: string; label: string }>();
  useEffect(() => {
    if (!created) return;
    const timer = setTimeout(() => setCreated(undefined), CAPTURE_TOAST_MS);
    return () => clearTimeout(timer);
  }, [created]);
  const capture = async (draft: TicketCapture) => {
    const ticket = await controller.captureTicket(draft);
    if (!ticket) return false;
    setCreated({ id: ticket.id, label: ticketLabel(ticket) });
    return true;
  };
  const activeSprint = sprints.find((candidate) => candidate.state === "active");
  const captureSprintId = (activeSprint ?? sprint)?.id ?? null;
  const assignees = useMemo(
    () => [...new Set(allTickets.flatMap((candidate) => candidate.ticket.assignee ?? []))].sort(),
    [allTickets],
  );
  const launchAgent = (focusTicketId: string | undefined) => void controller.launchAgent(focusTicketId);
  const [noteDialog, setNoteDialog] = useState<{ ticketId: string; kind: PmTicketNoteKind }>();
  const noteTicket = noteDialog && allTickets.find((candidate) => candidate.ticket.id === noteDialog.ticketId)?.ticket;
  const ticketActions = (id: string): ContextMenuItem[] => [
    { kind: "action", label: "Open", run: () => void controller.selectTicket(id) },
    { kind: "action", label: "Add note…", run: () => setNoteDialog({ ticketId: id, kind: "fact" }) },
    { kind: "action", label: "Follow a link…", run: () => setNoteDialog({ ticketId: id, kind: "source" }) },
    { kind: "action", label: "Update description from notes", disabled: !project, run: () => void controller.updateDescription(id) },
    { kind: "action", label: "Ask assistant", disabled: !project, run: () => launchAgent(id) },
  ];
  const stageTabs: StageTab[] = [
    { view: "overview", label: sprint ? `${sprint.name} overview` : "Overview" },
    ...(entry ? [{
      view: "ticket" as const,
      label: `${ticketLabel(entry.ticket)} · ${entry.ticket.title}`,
      draft: entry.pendingProposalCount > 0 || (state.proposals[entry.ticket.id]?.length ?? 0) > 0,
    }] : []),
    ...(activeAgent ? [{ view: "agent" as const, label: `${activeAgent.label} · ${activeAgent.detail}` }] : []),
    ...(jiraConnection === "connected" || view === "jira" ? [{ view: "jira" as const, label: "Jira issues" }] : []),
    { view: "settings", label: "Settings" },
  ];

  return (
    <SprintDnd
      lane={lane}
      laneSprintId={shownSprintId}
      onMoveTicket={(id, sprintId, index) => void controller.moveTicket(id, sprintId, index)}
      onSetStatus={(id, status) => void controller.setStatus(id, status)}
    >
      <div
        className={`shell ${right.open ? "right-open" : ""}`}
        style={{ "--left-width": `${fitted.left}px`, ...(fitted.right === undefined ? {} : { "--right-width": `${fitted.right}px` }) } as CSSProperties}
      >
        <Sidebar
          projects={state.projects}
          projectId={state.projectId}
          hasProject={Boolean(project)}
          view={view}
          jira={{ configured: jiraConfigured, status: jiraStatus(state), lastPullEpochMs: lastJiraPull(sprints, allTickets) }}
          pulling={state.pulling}
          now={now}
          sprints={sprints}
          tickets={allTickets}
          tier={tier}
          environments={board?.environments ?? EMPTY}
          versions={state.versions}
          selectedSprintId={state.selectedSprintId}
          selectedTicketId={state.selectedTicketId}
          agents={agents}
          activeAgentSessionId={state.activeAgentSessionId}
          onSelectProject={(id) => void controller.selectProject(id)}
          onCreateProject={(name) => void controller.createProject(name)}
          onView={(next) => controller.setView(next)}
          onPull={() => void controller.pullJira()}
          onStartAssistant={() => launchAgent(view === "ticket" ? ticketId : undefined)}
          onSelectAgent={(id) => controller.selectAgent(id)}
          onStopAgent={(id) => void controller.stopAgent(id)}
          ticketActions={ticketActions}
          onSelectSprint={(id) => controller.selectSprint(id)}
          onSelectTicket={(id) => void controller.selectTicket(id)}
          onCreateSprint={(name, goal) => void controller.createSprint(name, goal)}
          onCreateTicket={(title, sprintId) => void controller.createTicket(title, sprintId)}
          onMoveTicket={(id, sprintId, index) => void controller.moveTicket(id, sprintId, index)}
          onShowSprints={() => updateRight((current) => ({ ...current, open: true, view: "sprints" }))}
          width={fitted.left}
          widthBounds={LEFT_BOUNDS}
          onResize={(width) => setLeftWidth(clampLeftSidebarWidth(width))}
        />
        <main className="stage">
          <StageTabs tabs={stageTabs} view={view} onView={(next) => controller.setView(next)} />
          {state.notice && (
            <div className={`notice ${state.notice.tone}`} role={state.notice.tone === "error" ? "alert" : "status"}>
              <span>{state.notice.text}</span>
              <button type="button" className="icb" aria-label="Dismiss" onClick={() => controller.dismissNotice()}>×</button>
            </div>
          )}
          <div className="panes">
            {!project ? (
              <section className="pane">
                <div className="pane-head"><b>Welcome to TermLoop PM</b></div>
                <div className="body empty-state"><p className="lead">Create a project from the project picker in the sidebar to start planning.</p></div>
              </section>
            ) : view === "settings" ? (
              <SettingsPage
                projectName={project.name}
                projectFolder={project.folder}
                settings={state.settings}
                catalog={state.catalog}
                sources={state.sources}
                tracking={board?.tracking}
                environments={board?.environments ?? EMPTY}
                probes={board?.probes ?? EMPTY}
                now={now}
                onSaveSources={(jira, github) => controller.saveSources(jira, github)}
                onClearToken={() => void controller.clearJiraToken()}
                onPickFolder={() => controller.bridge.pickFolder()}
                onSetFolder={(folder) => void controller.setProjectFolder(folder)}
                onSaveSettings={(edit) => void controller.saveSettings(edit)}
                onSetEnvironments={(environments) => void controller.setEnvironments(environments)}
                onCreateProbe={(environment, argv, matcher) => void controller.createProbe(environment, argv, matcher)}
                onApproveProbe={(id) => void controller.approveProbe(id)}
                onRejectProbe={(id) => void controller.rejectProbe(id)}
                onDeleteProbe={(id) => void controller.deleteProbe(id)}
              />
            ) : view === "agent" ? (
              <AgentPanel
                tabs={agents}
                activeSessionId={state.activeAgentSessionId}
                canStart={Boolean(project)}
                focusLabel={entry ? ticketLabel(entry.ticket) : undefined}
                mountTerminal={mountTerminal}
                onStop={(id) => void controller.stopAgent(id)}
                onStart={() => launchAgent(ticketId)}
              />
            ) : view === "jira" ? (
              <JiraStage
                key={project.id}
                controller={controller}
                projectId={project.id}
                connection={jiraConnection}
                siteUrl={state.sources?.jira?.siteUrl}
                sprintId={activeSprint?.id ?? null}
                now={now}
              />
            ) : view === "ticket" && entry && ticketId ? (
              <TicketEditor
                key={ticketId}
                entry={entry}
                sprints={sprints}
                tier={tier}
                jiraConfigured={jiraConfigured}
                deployTracking={board?.tracking.deploy ?? false}
                proposals={state.proposals[ticketId] ?? EMPTY}
                versions={state.versions[ticketId]}
                now={now}
                onUpdate={(fields) => void controller.updateTicket(ticketId, fields)}
                onMoveSprint={(sprintId) => void controller.moveTicket(ticketId, sprintId)}
                onSaveDescription={(description, base) => controller.saveDescription(ticketId, description, base)}
                onLoadVersions={() => void controller.loadVersions(ticketId)}
                onAddCriterion={(text) => void controller.addCriterion(ticketId, text)}
                onSetCriterionDone={(id, done) => void controller.setCriterionDone(ticketId, id, done)}
                onRemoveCriterion={(id) => void controller.removeCriterion(ticketId, id)}
                onAddBlocker={(text) => void controller.addBlocker(ticketId, text)}
                onRemoveBlocker={(id) => void controller.removeBlocker(ticketId, id)}
                onAcceptProposal={(id, assignee) => void controller.acceptProposal(ticketId, id, assignee)}
                onRejectProposal={(id) => void controller.rejectProposal(ticketId, id)}
                onOpenLink={(url) => void controller.bridge.openExternal(url)}
                notes={{
                  notes: state.notes[ticketId],
                  canUpdate: Boolean(project),
                  onAddNote: (text) => void controller.addNote(ticketId, { kind: "fact", text, url: null }),
                  onFollowSource: () => setNoteDialog({ ticketId, kind: "source" }),
                  onRemoveNote: (id) => void controller.removeNote(ticketId, id),
                  onUpdateDescription: () => void controller.updateDescription(ticketId),
                }}
                onWriteToJira={() => void controller.openJiraDialog(ticketId)}
                onStartCheck={() => void controller.startCheck(ticketId)}
                onAskAgent={() => launchAgent(ticketId)}
              />
            ) : (
              <SprintOverview
                sprint={sprint}
                sprints={sprints}
                tickets={tickets}
                tier={tier}
                environments={board?.environments ?? EMPTY}
                digest={state.digest?.entries ?? EMPTY}
                now={now}
                onOpenTicket={(id) => void controller.selectTicket(id)}
                onActivate={(id) => void controller.activateSprint(id)}
                onClose={(id, carryOverTo) => void controller.closeSprint(id, carryOverTo)}
              />
            )}
          </div>
        </main>
        {right.open && (
          <RightSidebar
            view={right.view}
            width={fitted.right ?? right.width}
            bounds={RIGHT_BOUNDS}
            onResize={(width) => updateRight((current) => ({ ...current, width: clampRightSidebarWidth(width) }))}
            onClose={() => updateRight((current) => ({ ...current, open: false }))}
          >
            {right.view === "sprints" ? (
              <SprintsPanel
                sprints={sprints}
                tickets={allTickets}
                selectedSprintId={state.selectedSprintId}
                now={now}
                canCreate={Boolean(project)}
                onSelectSprint={(id) => controller.selectSprint(id)}
                onActivateSprint={(id) => void controller.activateSprint(id)}
                onCreateSprint={(name, goal) => void controller.createSprint(name, goal)}
              />
            ) : right.view === "suggestions" ? (
              <SuggestionsPanel
                suggestions={state.suggestions}
                tickets={allTickets}
                sprints={sprints}
                skills={state.skills?.skills ?? EMPTY}
                now={now}
                onAccept={(id, proposalId, assignee) => void controller.acceptProposal(id, proposalId, assignee)}
                onReject={(id, proposalId) => void controller.rejectProposal(id, proposalId)}
                onAcceptAll={(id) => void controller.acceptAllSuggestions(id)}
                onOpenTicket={(id) => void controller.selectTicket(id)}
                onOpenLink={(url) => void controller.bridge.openExternal(url)}
              />
            ) : (
              <SkillsPanel
                skills={state.skills}
                tier={tier}
                tickets={ticketsOnly}
                now={now}
                canCreate={Boolean(project)}
                onSetEnabled={(id, enabled) => void controller.setSkillEnabled(id, enabled)}
                onRun={(id) => void controller.runSkill(id)}
                onCreate={() => void controller.launchSkillCreator()}
                onRevise={(id) => void controller.launchSkillCreator(id)}
                onDryRun={(id) => void controller.dryRunDraft(id)}
                onDiscard={(id) => void controller.discardDraft(id)}
                onInstall={(id, tools, channels) => controller.installDraft(id, tools, channels.length > 0 ? channels : undefined)}
                onOpenLink={(url) => void controller.bridge.openExternal(url)}
              />
            )}
          </RightSidebar>
        )}
        <RightActivityBar
          open={right.open}
          view={right.view}
          onSelect={(next) => updateRight((current) => toggleRightSidebar(current, next))}
          jira={{ available: Boolean(project) && jiraConnection === "connected", active: view === "jira", onToggle: () => controller.toggleJiraStage() }}
        />
        {capturing && (
          <QuickCapture
            sprints={sprints}
            defaultSprintId={captureSprintId}
            assignees={assignees}
            canAskAssistant={Boolean(project)}
            onCreate={capture}
            onClose={() => setCapturing(false)}
          />
        )}
        {created && (
          <CaptureToast
            label={created.label}
            onOpen={() => { setCreated(undefined); setCapturing(false); void controller.selectTicket(created.id); }}
            onDismiss={() => setCreated(undefined)}
          />
        )}
        {noteDialog && noteTicket && (
          <NoteDialog
            key={`${noteDialog.ticketId}:${noteDialog.kind}`}
            kind={noteDialog.kind}
            ticketLabel={`${ticketLabel(noteTicket)} · ${noteTicket.title}`}
            onSubmit={(draft) => controller.addNote(noteDialog.ticketId, draft)}
            onClose={() => setNoteDialog(undefined)}
          />
        )}
        {state.jiraDialog && (
          <JiraSyncDialog dialog={state.jiraDialog} onApply={() => void controller.applyJira()} onClose={() => controller.closeJiraDialog()} />
        )}
      </div>
    </SprintDnd>
  );
}

/** The right sidebar layout, remembered across launches. */
function useRightSidebar(): [RightSidebarPreference, (update: (current: RightSidebarPreference) => RightSidebarPreference) => void] {
  const [preference, setPreference] = useState(readRightSidebarPreference);
  useEffect(() => writeRightSidebarPreference(preference), [preference]);
  return [preference, setPreference];
}

function useLeftSidebarWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => readLeftSidebarPreference().width);
  useEffect(() => writeLeftSidebarPreference({ width }), [width]);
  return [width, setWidth];
}

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/**
 * A native Ghostty view follows its host element through a ResizeObserver,
 * which misses a pure move. Widening the left sidebar can move a stage
 * terminal without resizing it, so announce a window resize to resync frames.
 */
function useNudgeNativeSurfaces(leftWidth: number): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.dispatchEvent(new Event("resize"));
  }, [leftWidth]);
}

/**
 * Opens quick capture on double Shift or Cmd/Ctrl+N in the page, and on the
 * same keys forwarded by main while a native terminal holds focus.
 */
function useCaptureShortcut(controller: PmController, enabled: boolean, open: () => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!enabled) return;
    const detector = new DoubleShiftDetector();
    const mac = /Mac/.test(navigator.platform);
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (isNewTicketShortcut(event, mac)) {
        event.preventDefault();
        detector.reset();
        openRef.current();
      } else if (detector.keyDown(event)) {
        openRef.current();
      }
    };
    const keyUp = (event: KeyboardEvent) => detector.keyUp(event);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    const stopNative = controller.bridge.onNativeShortcut((shortcut) => {
      detector.reset();
      if (shortcut === "quickCapture") openRef.current();
    });
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      stopNative();
    };
  }, [controller, enabled]);
}

function ConnectionScreen({ connection }: { connection: PmState["connection"] }) {
  return (
    <div className="connection">
      <div className="connection-card">
        <div className="brand"><span className="logo" /><b>TermLoop PM</b></div>
        {connection.state === "failed" ? (
          <>
            <p className="error">Could not reach the PM daemon.</p>
            <pre className="pre">{connection.message}</pre>
          </>
        ) : <p className="hint">Starting the PM daemon…</p>}
      </div>
    </div>
  );
}

function jiraStatus(state: PmState): string {
  if (!state.sources?.jira) return "Jira not connected";
  const pull = state.lastPull;
  if (!pull) return "Jira connected";
  return pull.outcome.kind === "applied" ? "Jira pulled" : "Jira pull needs attention";
}

function agentLabel(session: PmAgentSession, tickets: PmBoardTicket[], skills: PmSkill[]): string {
  switch (session.mode) {
    case "assistant": return "Assistant";
    case "deliveryCheck": return `Check ${checkLabel(tickets, session.focusTicketId)}`;
    case "skillCreator": return "Skill creator";
    case "skillRun": return skills.find((skill) => skill.id === session.skillId)?.manifest.name ?? "Skill run";
  }
}

function checkLabel(tickets: PmBoardTicket[], ticketId: string | null): string {
  const entry = tickets.find((candidate) => candidate.ticket.id === ticketId);
  return entry ? ticketLabel(entry.ticket) : "ticket";
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
