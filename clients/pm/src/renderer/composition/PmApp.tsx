// Composition: binds store state to UI props and UI intents to the
// controller. The only renderer layer that sees both the bridge-backed
// controller and the terminal adapter.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PmBoardTicket } from "@termloop/pm-contract/pm";
import type { PmApi } from "../../pm-api.js";
import { usePmState, type PmState } from "../state/presentation-store.js";
import { mountAgentTerminal } from "../terminal/agent-terminal.js";
import { xtermSurface } from "../terminal/xterm-surface.js";
import { AgentPanel, type AgentTab } from "../ui/AgentPanel.js";
import { Header } from "../ui/Header.js";
import { JiraSyncDialog } from "../ui/JiraSyncDialog.js";
import { SettingsPage } from "../ui/SettingsPage.js";
import { SprintOverview } from "../ui/SprintOverview.js";
import { SprintSidebar } from "../ui/SprintSidebar.js";
import { TicketEditor } from "../ui/TicketEditor.js";
import { sprintTickets, ticketLabel } from "../ui/format.js";
import type { MountTerminal } from "../ui/types.js";
import type { PmController } from "./pm-controller.js";

const EMPTY: never[] = [];

export function PmApp({ controller, terminal }: { controller: PmController; terminal: PmApi["terminal"] | undefined }) {
  const store = controller.store;
  const state = usePmState(store, (value) => value);
  const now = useNow();
  useEffect(() => {
    void controller.start();
    return () => controller.dispose();
  }, [controller]);
  const mountTerminal = useCallback<MountTerminal>(
    (host, sessionId) => (terminal ? mountAgentTerminal(terminal, host, sessionId, xtermSurface) : () => undefined),
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
  const tabs: AgentTab[] = state.agents.map((session) => ({
    sessionId: session.sessionId,
    state: session.state,
    assistant: session.mode === "assistant",
    label: session.mode === "assistant" ? "PM agent" : `Check · ${checkLabel(allTickets, session.focusTicketId)}`,
  }));
  const ticketId = entry?.ticket.id;

  return (
    <div className="pm-app">
      <Header
        projects={state.projects}
        projectId={state.projectId}
        view={state.view}
        ticketSelected={Boolean(entry)}
        jira={{ configured: jiraConfigured, status: jiraStatus(state) }}
        pulling={state.pulling}
        onSelectProject={(id) => void controller.selectProject(id)}
        onCreateProject={(name) => void controller.createProject(name)}
        onView={(view) => controller.setView(view)}
        onPull={() => void controller.pullJira()}
      />
      {state.notice && (
        <div className={`pm-notice ${state.notice.tone}`} role={state.notice.tone === "error" ? "alert" : "status"}>
          <span>{state.notice.text}</span>
          <button type="button" className="pm-icon-button" aria-label="Dismiss" onClick={() => controller.dismissNotice()}>×</button>
        </div>
      )}
      <div className="pm-body">
        <SprintSidebar
          sprints={sprints}
          tickets={allTickets}
          tier={tier}
          selectedSprintId={state.selectedSprintId}
          selectedTicketId={state.selectedTicketId}
          onSelectSprint={(id) => controller.selectSprint(id)}
          onSelectTicket={(id) => void controller.selectTicket(id)}
          onCreateSprint={(name, goal) => void controller.createSprint(name, goal)}
          onCreateTicket={(title) => void controller.createTicket(title)}
        />
        <main className="pm-center">
          {!project ? (
            <section className="pm-empty">
              <h2>Welcome to TermLoop PM</h2>
              <p className="pm-hint">Create a project with the + next to the project name to start planning.</p>
            </section>
          ) : state.view === "settings" ? (
            <SettingsPage
              projectName={project.name}
              settings={state.settings}
              sources={state.sources}
              tracking={board?.tracking}
              environments={board?.environments ?? EMPTY}
              probes={board?.probes ?? EMPTY}
              now={now}
              onSaveSources={(jira, github) => controller.saveSources(jira, github)}
              onClearToken={() => void controller.clearJiraToken()}
              onSaveSettings={(edit) => void controller.saveSettings(edit)}
              onSetEnvironments={(environments) => void controller.setEnvironments(environments)}
              onCreateProbe={(environment, argv, matcher) => void controller.createProbe(environment, argv, matcher)}
              onApproveProbe={(id) => void controller.approveProbe(id)}
              onRejectProbe={(id) => void controller.rejectProbe(id)}
              onDeleteProbe={(id) => void controller.deleteProbe(id)}
            />
          ) : state.view === "ticket" && entry && ticketId ? (
            <TicketEditor
              entry={entry}
              sprintName={sprints.find((candidate) => candidate.id === entry.ticket.sprintId)?.name}
              tier={tier}
              jiraConfigured={jiraConfigured}
              deployTracking={board?.tracking.deploy ?? false}
              proposals={state.proposals[ticketId] ?? EMPTY}
              versions={state.versions[ticketId]}
              now={now}
              onUpdate={(fields) => void controller.updateTicket(ticketId, fields)}
              onSaveDescription={(description, base) => controller.saveDescription(ticketId, description, base)}
              onLoadVersions={() => void controller.loadVersions(ticketId)}
              onAddCriterion={(text) => void controller.addCriterion(ticketId, text)}
              onSetCriterionDone={(id, done) => void controller.setCriterionDone(ticketId, id, done)}
              onRemoveCriterion={(id) => void controller.removeCriterion(ticketId, id)}
              onAddBlocker={(text) => void controller.addBlocker(ticketId, text)}
              onRemoveBlocker={(id) => void controller.removeBlocker(ticketId, id)}
              onAcceptProposal={(id) => void controller.acceptProposal(ticketId, id)}
              onRejectProposal={(id) => void controller.rejectProposal(ticketId, id)}
              onOpenLink={(url) => void controller.bridge.openExternal(url)}
              onWriteToJira={() => void controller.openJiraDialog(ticketId)}
              onStartCheck={() => void controller.startCheck(ticketId)}
              onAskAgent={() => void controller.launchAgent(ticketId)}
            />
          ) : (
            <SprintOverview
              sprint={sprint}
              sprints={sprints}
              tickets={tickets}
              tier={tier}
              digest={state.digest?.entries ?? EMPTY}
              now={now}
              onOpenTicket={(id) => void controller.selectTicket(id)}
              onActivate={(id) => void controller.activateSprint(id)}
              onClose={(id, carryOverTo) => void controller.closeSprint(id, carryOverTo)}
            />
          )}
        </main>
        <AgentPanel
          tabs={tabs}
          activeSessionId={state.activeAgentSessionId}
          canStart={Boolean(project)}
          focusLabel={entry ? ticketLabel(entry.ticket) : undefined}
          mountTerminal={mountTerminal}
          onSelect={(id) => controller.selectAgent(id)}
          onStop={(id) => void controller.stopAgent(id)}
          onStart={() => void controller.launchAgent(state.view === "ticket" ? ticketId : undefined)}
        />
      </div>
      {state.jiraDialog && (
        <JiraSyncDialog dialog={state.jiraDialog} onApply={() => void controller.applyJira()} onClose={() => controller.closeJiraDialog()} />
      )}
    </div>
  );
}

function ConnectionScreen({ connection }: { connection: PmState["connection"] }) {
  return (
    <div className="pm-app pm-connection">
      <div className="pm-connection-card">
        <h1>TermLoop PM</h1>
        {connection.state === "failed" ? (
          <>
            <p className="pm-error">Could not reach the PM daemon.</p>
            <pre className="pm-pre">{connection.message}</pre>
          </>
        ) : <p className="pm-hint">Starting the PM daemon…</p>}
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
