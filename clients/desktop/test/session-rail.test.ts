import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { SessionRail, type SessionRailProps } from "../src/renderer/ui/SessionRail.js";
import { SessionContextMenu, SessionRowButton, type SessionRunDevServer } from "../src/renderer/ui/SessionRow.js";
import { isProjectRelocationDragCandidate, isTaskRelocationDragCandidate, splitDropPositionFromPoint } from "../src/renderer/ui/SidebarSessionDnd.js";

/// This rail holds the Project's own non-Agent Sessions. Agent rows, their
/// states, and their recovery actions are asserted in
/// `agent-row-presentation.test.ts`, against the Agents rail that lists every
/// Agent in the Project.

function terminalSession(): Session {
  return {
    id: "terminal-1",
    project_id: "project-1",
    name: null,
    kind: "Terminal",
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    process: {
      program: "/bin/zsh",
      args: [],
      cwd: "/Users/demo/project",
      agent_id: null,
      template_ref: null,
      template_version: null,
    },
  };
}

function renderRail(sessions: readonly Session[]): string {
  const props: SessionRailProps = {
    sessions,
    selectedSession: undefined,
    visibleSessionIds: new Set(),
    menuSessionId: undefined,
    selectSession: () => {},
    navigateSession: () => {},
    openSessionMenu: () => {},
    dismissSession: () => {},
    resumeSession: () => {},
    reorderSession: () => true,
  };
  return renderToStaticMarkup(createElement(SessionRail, props));
}

describe("Session rail structure", () => {

  it("chooses the split edge nearest to the drop point", () => {
    expect(splitDropPositionFromPoint(0.1, 0.5)).toEqual({ direction: "horizontal", placement: "before" });
    expect(splitDropPositionFromPoint(0.9, 0.5)).toEqual({ direction: "horizontal", placement: "after" });
    expect(splitDropPositionFromPoint(0.5, 0.1)).toEqual({ direction: "vertical", placement: "before" });
    expect(splitDropPositionFromPoint(0.5, 0.9)).toEqual({ direction: "vertical", placement: "after" });
  });

  it("offers Task drop only for a running ordinary Claude or Codex Agent", () => {
    const ordinary: Session = {
      ...terminalSession(),
      id: "ordinary-agent",
      kind: "Agent",
      process: {
        ...terminalSession().process,
        agent_id: "codex",
        template_ref: "builtin.agent.interactive",
        template_version: 1,
      },
    };

    expect(isTaskRelocationDragCandidate(ordinary)).toBe(true);
    expect(isTaskRelocationDragCandidate({
      ...ordinary,
      process: { ...ordinary.process, agent_id: "claude", template_ref: "builtin.quick-action.free-prompt" },
    })).toBe(true);
    expect(isTaskRelocationDragCandidate({
      ...ordinary,
      lifecycle_state: "resumeFailed",
      retryable: true,
    })).toBe(true);
    expect(isTaskRelocationDragCandidate({
      ...ordinary,
      lifecycle_state: "resumeFailed",
      retryable: false,
    })).toBe(false);
    expect(isTaskRelocationDragCandidate({ ...ordinary, ask_to_source_session_id: "source-agent" })).toBe(false);
    expect(isTaskRelocationDragCandidate({
      ...ordinary,
      process: { ...ordinary.process, template_ref: "builtin.steward.executor" },
    })).toBe(false);
    expect(isTaskRelocationDragCandidate(terminalSession())).toBe(false);

    const helper = {
      ...ordinary,
      ask_to_source_session_id: "source-agent",
      process: { ...ordinary.process, template_ref: "builtin.agent.ask-to-helper" },
    };
    expect(isProjectRelocationDragCandidate(helper)).toBe(true);
    expect(isProjectRelocationDragCandidate({
      ...ordinary,
      process: { ...ordinary.process, template_ref: "builtin.steward.task-assignment" },
    })).toBe(true);
    expect(isProjectRelocationDragCandidate(terminalSession())).toBe(false);
  });

  /// Nothing to say and no height taken from the Task list above it. The rail
  /// also never grows launch actions of its own; those live on the view bar.
  it("renders nothing while the Project has no terminal", () => {
    expect(renderRail([])).toBe("");
    const agent: Session = {
      ...terminalSession(),
      id: "loose-agent",
      kind: "Agent",
      process: { ...terminalSession().process, agent_id: "codex", template_ref: "builtin.agent.interactive" },
    };
    /// Agents belong to the Agents view, which holds all of them. A partial
    /// second list under the Tasks view is exactly what this rail dropped.
    expect(renderRail([agent])).toBe("");
  });

  it("forwards the drag activator across the whole Session row", () => {
    const ordinary: Session = {
      ...terminalSession(),
      id: "loose-agent",
      name: "Loose agent",
      kind: "Agent",
      process: {
        ...terminalSession().process,
        agent_id: "codex",
        template_ref: "builtin.agent.interactive",
        template_version: 1,
      },
    };
    const markup = renderToStaticMarkup(createElement(SessionRowButton, {
      session: ordinary,
      agentStatus: undefined,
      subtitle: "project",
      active: false,
      visible: false,
      menuOpen: false,
      dragAttributes: {
        role: "button",
        tabIndex: 0,
        "aria-disabled": false,
        "aria-pressed": undefined,
        "aria-roledescription": "draggable",
        "aria-describedby": "drag-instructions",
      },
      dragListeners: { onPointerDown: () => {} },
      select: () => {},
      openMenu: () => {},
    }));

    expect(markup).toContain('data-session-id="loose-agent"');
    expect(markup).toContain('aria-roledescription="draggable"');
  });


  it("renders the Terminals section when a terminal exists", () => {
    const markup = renderRail([terminalSession()]);
    expect(markup).toContain('aria-label="Terminal sessions"');
    expect(markup).toContain("<h2>Terminals</h2>");
    expect(markup).toContain('data-session-id="terminal-1"');
    expect(markup).toContain('aria-label="Reorder project"');
    /// Titled by its own folder, so the state line does not repeat it.
    expect(markup).toContain('<strong class="row-title">project</strong>');
    expect(markup).not.toContain("row-subtitle");
    expect(markup).toContain('class="row-agent">zsh</span>');
    /// Archive is an ordinary-Agent action; a generic terminal never offers it.
    expect(markup).not.toContain("Archive ");
  });








  /// The state line is the narrowest line in the row, so it never repeats what the
  /// identity zone directly above it already said.












  it("offers conversation fork for every agent without a client-side capability gate", () => {
    const renderMenu = (session: Session, relocateSession?: () => void, relocateToProject?: () => void, refreshAgent?: () => void) => renderToStaticMarkup(createElement(SessionContextMenu, {
      state: { sessionId: session.id, x: 10, y: 10, invoker: {} as HTMLElement },
      session,
      visible: false,
      canSplit: true,
      closeMenu: () => {},
      openHere: () => {},
      openInSplit: () => {},
      focus: () => {},
      closePane: () => {},
      rename: () => {},
      forkSession: () => {},
      refreshAgent,
      relocateSession,
      relocateToProject,
      copySessionId: () => {},
      dismissSession: () => {},
    }));
    expect(renderMenu(terminalSession())).not.toContain("Fork conversation");
    const agent = {
      ...terminalSession(),
      kind: "Agent" as const,
      forkable: true,
      process: { ...terminalSession().process, agent_id: "claude" },
    };
    expect(renderMenu(agent)).toContain("Fork conversation");
    expect(renderMenu({ ...agent, forkable: false })).not.toContain('disabled=""');
    expect(renderMenu(agent)).not.toContain("Continue in Task worktree");
    expect(renderMenu(agent, () => {})).toContain("Continue in Task worktree…");
    expect(renderMenu(agent, () => {})).toContain("Replace this process inside the Task worktree");
    expect(renderMenu(agent, undefined, () => {})).toContain("Move to Project checkout…");
    expect(renderMenu(agent, undefined, () => {})).toContain("Resume this conversation in the Project checkout");
    expect(renderMenu(agent)).not.toContain("Refresh agent display");
    expect(renderMenu(agent, undefined, undefined, () => {})).toContain("Refresh agent display");
    expect(renderMenu(agent, undefined, undefined, () => {})).toContain("continue the same conversation");
  });

  it("offers Ask-To providers and exact running Session handover targets under Agents", () => {
    const source = {
      ...terminalSession(),
      id: "123e4567-e89b-42d3-a456-426614174000",
      kind: "Agent" as const,
      process: { ...terminalSession().process, agent_id: "claude" },
    };
    const target = {
      ...source,
      id: "123e4567-e89b-42d3-a456-426614174001",
      name: "Review agent",
      process: { ...source.process, agent_id: "codex" },
    };
    const markup = renderToStaticMarkup(createElement(SessionContextMenu, {
      state: { sessionId: source.id, x: 10, y: 10, invoker: {} as HTMLElement },
      session: source,
      visible: false,
      canSplit: true,
      closeMenu: () => {},
      openHere: () => {},
      openInSplit: () => {},
      focus: () => {},
      closePane: () => {},
      rename: () => {},
      forkSession: () => {},
      agentActions: {
        askTargets: [
          { agentId: "claude", label: "Claude" },
          { agentId: "codex", label: "Codex" },
        ],
        handoverTargets: [target],
        askTo: () => {},
        handoverTo: () => {},
      },
      copySessionId: () => {},
      dismissSession: () => {},
    }));

    expect(markup).toContain("Agents");
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain("Ask to");
    expect(markup).toContain("Start a tracked helper request");
    expect(markup).toContain("Handover to");
    expect(markup).toContain("Review agent");
    expect(markup).toContain("123e4567");
  });

  it("names the worktree the menu's dev server would run in, and opens a run already live there", () => {
    const agent = {
      ...terminalSession(),
      kind: "Agent" as const,
      forkable: true,
      process: { ...terminalSession().process, agent_id: "claude" },
    };
    const renderMenu = (runDevServer?: SessionRunDevServer) => renderToStaticMarkup(createElement(SessionContextMenu, {
      state: { sessionId: agent.id, x: 10, y: 10, invoker: {} as HTMLElement },
      session: agent,
      visible: false,
      canSplit: true,
      closeMenu: () => {},
      openHere: () => {},
      openInSplit: () => {},
      focus: () => {},
      closePane: () => {},
      rename: () => {},
      forkSession: () => {},
      runDevServer,
      copySessionId: () => {},
      dismissSession: () => {},
    }));
    const offer = (over: Partial<SessionRunDevServer> = {}): SessionRunDevServer => ({
      name: "Dev server",
      running: false,
      start: () => {},
      ...over,
    });

    // An Agent outside a Task worktree, or a Project with no dev server
    // configuration, gets no offer at all — Shell resolves both to undefined.
    expect(renderMenu()).not.toContain("Run dev server");

    expect(renderMenu(offer())).toContain("Run dev server");
    expect(renderMenu(offer())).toContain("Start Dev server in this Task&#x27;s worktree");

    // Already live in that same worktree: the action opens it instead of
    // starting a second server against the same source.
    const live = renderMenu(offer({ running: true }));
    expect(live).toContain("Open dev server");
    expect(live).toContain("Dev server is already running in this Task&#x27;s worktree");
    expect(live).not.toContain("Run dev server");
  });
});
