import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { ActiveAgentRail, type ActiveAgentRailProps } from "../src/renderer/ui/ActiveAgentRail.js";
import { SessionRowClose } from "../src/renderer/ui/SessionRow.js";

/// Agent row anatomy, state words, and recovery actions, rendered through the
/// Agents rail. That rail is the one surface holding every Agent in a Project,
/// so these assertions moved here from the Tasks view's retired loose-Agent
/// list rather than being dropped with it.

function agentSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "agent-1",
    project_id: "project-1",
    name: null,
    kind: "Agent",
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
      program: "/usr/local/bin/codex",
      args: [],
      cwd: "/Users/demo/project",
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: 1,
    },
    ...overrides,
  } as Session;
}

function render(
  sessions: readonly Session[],
  statuses: readonly AgentStatus[] = [],
  reviewReadySessionIds: ReadonlySet<string> = new Set(),
  options: {
    agentGroups?: readonly import("../src/layout/model.js").AgentGroupLayout[];
    detachedRelationshipSessionIds?: ReadonlySet<string>;
    detachRelationship?: (sessionId: string) => void;
  } = {},
): string {
  const props: ActiveAgentRailProps = {
    sessions,
    projectFolder: "/Users/demo/other-project",
    selectedSession: undefined,
    visibleSessionIds: new Set(),
    statusesById: new Map(statuses.map((status) => [status.sessionId, status])),
    reviewReadySessionIds,
    favoriteSessionIds: new Set(),
    taskAttachedSessionIds: new Set(),
    worktreeChangesBySessionId: new Map(),
    menuSessionId: undefined,
    selectSession: () => {},
    navigateSession: () => {},
    openSessionMenu: () => {},
    dismissSession: () => {},
    resumeSession: () => {},
    archiveSession: () => {},
    toggleFavoriteSession: () => {},
    openTaskChanges: () => {},
    searchOpen: false,
    setSearchOpen: () => {},
    nowEpochMs: 100,
    ...(options.agentGroups ? { agentGroups: options.agentGroups } : {}),
    ...(options.detachedRelationshipSessionIds ? { detachedRelationshipSessionIds: options.detachedRelationshipSessionIds } : {}),
    ...(options.detachRelationship ? { detachRelationship: options.detachRelationship } : {}),
  };
  return renderToStaticMarkup(createElement(ActiveAgentRail, props));
}

function status(sessionId: string, value: AgentStatus["status"], source: AgentStatus["source"] = "appServer"): AgentStatus {
  return { sessionId, status: value, source, observedAtEpochMs: 1 };
}

describe("improver rows", () => {
  function improverSession(): Session {
    return agentSession({
      id: "improver-1",
      name: "set up: dev server",
      process: {
        program: "/usr/local/bin/claude",
        args: [],
        cwd: "/Users/demo/project",
        agent_id: "claude",
        template_ref: "builtin.improver.run-configuration-new",
        template_version: 1,
      },
    });
  }

  /// An improver is an ordinary Agent doing one narrow job that ends in a
  /// proposal. Reading as another "Claude" in the rail hides both what it is
  /// working on and that it owes the user an answer.
  it("states its kind and what it is working on", () => {
    const markup = render([improverSession()]);
    expect(markup).toContain("set up: dev server");
    expect(markup).toContain("row-improve-kind");
    expect(markup).toContain("Improver");
    expect(markup).toContain("improve-badge");
    // The title already names the job, so the provider name is not repeated.
    expect(markup).not.toContain("row-agent");
  });

  it("offers close for running, retryable, and stopped improvers", () => {
    expect(render([improverSession()])).toContain('aria-label="Close set up: dev server"');
    const retryable = render([{
      ...improverSession(),
      lifecycle_state: "resumeFailed",
      retryable: true,
      closable: false,
      resume_failure_reason: "runtimeOwnershipUncertain",
    } as Session]);
    expect(retryable).toContain('aria-label="Retry set up: dev server"');
    expect(retryable).toContain('aria-label="Close set up: dev server"');
    expect(render([{
      ...improverSession(),
      lifecycle_state: "exited",
      retryable: true,
      closable: true,
    } as Session])).toContain('aria-label="Remove set up: dev server"');
  });

  it("leaves an ordinary agent row untouched", () => {
    const markup = render([agentSession({ id: "ordinary" })]);
    expect(markup).not.toContain("row-improve-kind");
    expect(markup).not.toContain("improve-badge");
  });

  /// The kind comes from the launch template, never from the name, so renaming
  /// a Session cannot turn an ordinary agent into an improver or hide one.
  it("ignores a name that only looks like an improver", () => {
    const impostor = agentSession({
      name: "improve: everything",
      process: { ...improverSession().process, template_ref: "builtin.agent.interactive" },
    });
    expect(render([impostor])).not.toContain("row-improve-kind");
  });
});

describe("Agent row anatomy", () => {
  it("holds one identity zone and one state line ordered by descending urgency", () => {
    const agent = agentSession({
      id: "agent-line",
      name: "Renewal flow",
      process: { ...agentSession().process, agent_id: "claude", cwd: "/Users/demo/project/clients/desktop" },
    });
    const markup = render([agent], [status(agent.id, "awaitingInput", "hook")]);

    /// Exactly one `<strong>`, holding exactly the label: the F1 rename script
    /// reads the Session name through `[data-session-id] strong`.
    expect(markup.match(/<strong class="row-title">/gu)).toHaveLength(1);
    expect(markup).toContain('<strong class="row-title">Renewal flow</strong>');
    /// State, then what is driving it, then where it runs. The retired right-hand
    /// tail put the state word after the folder and let its position move.
    const line = markup.slice(markup.indexOf('class="session-state-line"'));
    expect(line.indexOf(">Needs input<")).toBeLessThan(line.indexOf(">Claude<"));
    expect(line.indexOf(">Claude<")).toBeLessThan(line.indexOf(">desktop<"));
    expect(markup).not.toContain('class="row-meta"');
    expect(markup).not.toContain('class="row-tail"');
  });

  /// The state line is the narrowest line in the row, so it never repeats what
  /// the identity zone directly above it already said.
  it("drops a provenance token that only repeats the row title", () => {
    const markup = render([agentSession({ id: "agent-unnamed" })]);
    expect(markup).toContain('<strong class="row-title">Codex</strong>');
    expect(markup).not.toContain("row-agent");
    /// The folder still differs from the title here, so it survives.
    expect(markup).toContain('class="row-subtitle" title="/Users/demo/project">project</small>');
  });

  it("marks working agents with the working row state", () => {
    const agent = agentSession();
    expect(render([agent], [status(agent.id, "working")])).toContain("session-item agent state-working");
  });

  it("keeps an idle agent ready for review until the presentation acknowledges it", () => {
    const agent = agentSession({ id: "agent-review" });
    const markup = render([agent], [status(agent.id, "idle", "hook")], new Set([agent.id]));
    expect(markup).toContain("session-item agent state-review");
    expect(markup).toContain(">Needs review</em>");
    expect(markup).toContain("agent-status-readyForReview");
  });

  it("renders an interrupted Codex turn distinctly from idle", () => {
    const agent = agentSession({ id: "agent-interrupted" });
    const markup = render([agent], [status(agent.id, "interrupted")]);
    expect(markup).toContain("session-item agent state-interrupted");
    expect(markup).toContain("agent-status-interrupted");
    expect(markup).toContain(">Interrupted</em>");
  });
});

describe("Agent row actions", () => {
  it("places Archive Agent immediately beside close for ordinary resumable Agent rows", () => {
    const agent = agentSession({
      id: "agent-archivable",
      name: "Claude work",
      closable: true,
      process: { ...agentSession().process, agent_id: "claude" },
    });
    const markup = render([agent]);
    const archive = markup.indexOf('aria-label="Archive Claude work"');
    const close = markup.indexOf('aria-label="Close Claude work"');
    expect(archive).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(archive);
    expect(markup).toContain('class="row-action archive-action"');
  });

  it("offers archive for legacy ordinary Agents without a launch template", () => {
    const agent = agentSession({
      id: "legacy-agent",
      name: "Legacy agent",
      process: { program: "/usr/local/bin/claude", args: [], cwd: "/Users/demo/project", agent_id: "claude", template_ref: null, template_version: null },
    });
    expect(render([agent])).toContain('aria-label="Archive Legacy agent"');
  });

  it("does not offer Agent archive for Ask-To helpers", () => {
    const source = agentSession({ id: "source", name: "Source" });
    const helper = agentSession({
      id: "helper-no-archive",
      name: "Helper",
      ask_to_source_session_id: source.id,
      process: { ...agentSession().process, agent_id: "claude", template_ref: "builtin.agent.ask-to-helper" },
    });
    expect(render([source, helper])).not.toContain('aria-label="Archive Helper"');
  });

  /// Steward and Worker Sessions never reach this rail, so the refusal is
  /// asserted on the row control itself: archive stays an ordinary-Agent action
  /// wherever that control is used.
  it("does not offer archive for Steward or Worker assistant roles", () => {
    for (const template of ["builtin.steward.executor", "builtin.worker.executor"]) {
      const assistant = agentSession({
        id: template,
        name: template,
        process: { ...agentSession().process, agent_id: "claude", template_ref: template },
      });
      const markup = renderToStaticMarkup(createElement(SessionRowClose, {
        session: assistant,
        dismiss: () => {},
        archive: () => {},
        resume: () => {},
      }));
      expect(markup).not.toContain("Archive ");
    }
  });

  it("presents a retryable resume failure instead of the last exited runtime status", () => {
    const agent = agentSession({
      id: "agent-retry",
      lifecycle_state: "resumeFailed",
      retryable: true,
      resume_failure_reason: "cwdUnavailable",
    });
    const markup = render([agent], [status(agent.id, "exited")]);
    expect(markup).toContain(">Retry available</em>");
    expect(markup).toContain("Its conversation could not resume, and a retry is available.");
    expect(markup).toContain("session-item agent state-blocked");
    const retry = markup.indexOf('aria-label="Retry Codex"');
    const close = markup.indexOf('aria-label="Close Codex"');
    expect(retry).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(retry);
    expect(markup).toContain('class="row-action retry-action"');
    expect(markup).not.toContain(">Exited</em>");
  });

  it("offers Retry next to close after an ordinary Agent exit", () => {
    const agent = agentSession({
      id: "agent-resume",
      lifecycle_state: "exited",
      retryable: true,
      closable: true,
    });
    const markup = render([agent]);
    const retry = markup.indexOf('aria-label="Retry Codex"');
    const close = markup.indexOf('aria-label="Remove Codex"');
    expect(retry).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(retry);
    expect(markup).toContain('class="row-action retry-action"');
  });

  it("offers one-click Fix for a provider-history-damaged Agent", () => {
    const agent = agentSession({
      id: "agent-history-fix",
      name: "AgentTerminalSend",
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "providerHistoryDamaged",
      retryable: false,
      closable: true,
    });
    const markup = render([agent]);
    expect(markup).toContain('aria-label="Fix AgentTerminalSend"');
    expect(markup).toContain('title="Repair provider history and retry Agent"');
    expect(markup).not.toContain('aria-label="Retry AgentTerminalSend"');
  });
});

describe("Agent relationships", () => {
  it("nests an Ask-To helper once beneath its exact source agent", () => {
    const source = agentSession({ id: "asker-1", name: "Primary Codex" });
    const helper = agentSession({
      id: "helper-1",
      name: "Claude helper",
      ask_to_source_session_id: source.id,
      process: { ...source.process, agent_id: "claude", template_ref: "builtin.agent.ask-to-helper" },
    });

    const markup = render([helper, source]);
    const sourceIndex = markup.indexOf('data-session-id="asker-1"');
    const relationIndex = markup.indexOf("from Primary Codex");
    const helperIndex = markup.indexOf('data-session-id="helper-1"');
    expect(sourceIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeLessThan(relationIndex);
    expect(relationIndex).toBeLessThan(helperIndex);
    expect(markup.match(/data-session-id="helper-1"/gu)).toHaveLength(1);
    expect(markup).toContain("Claude helper, from Primary Codex, Running., Claude, /Users/demo/project");
  });

  it("offers a connector control and renders a detached helper independently", () => {
    const source = agentSession({ id: "source", name: "Source" });
    const helper = agentSession({ id: "helper", name: "Helper", ask_to_source_session_id: source.id });

    const connected = render([source, helper], [], new Set(), { detachRelationship: () => {} });
    expect(connected).toContain('class="ask-to-helper-detach"');
    expect(connected).toContain('aria-label="Show Helper separately from Source"');

    const detached = render([source, helper], [], new Set(), {
      detachedRelationshipSessionIds: new Set([helper.id]),
      detachRelationship: () => {},
    });
    expect(detached).not.toContain("active-agent-helper");
    expect(detached.indexOf('data-session-id="source"')).toBeLessThan(detached.indexOf('data-session-id="helper"'));
  });

  it("keeps an Ask-To helper top-level when its projected source is absent", () => {
    const helper = agentSession({
      id: "orphan-helper",
      ask_to_source_session_id: "missing-source",
      process: { ...agentSession().process, agent_id: "claude", template_ref: "builtin.agent.ask-to-helper" },
    });

    const markup = render([helper]);
    expect(markup).toContain('data-session-id="orphan-helper"');
    expect(markup).not.toContain("active-agent-helper");
  });
});
