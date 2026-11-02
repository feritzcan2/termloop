import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { SessionRowButton, agentSubagentRowText } from "../src/renderer/ui/SessionRow.js";

function agentSession(lifecycle_state = "running"): Session {
  return {
    id: "claude-1",
    project_id: "project-1",
    name: "Lead",
    kind: "Agent",
    lifecycle_state,
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    process: {
      program: "claude",
      args: [],
      cwd: "/Users/demo/project",
      agent_id: "claude",
      template_ref: null,
      template_version: null,
    },
  } as Session;
}

function subagent(index: number, fields: Partial<NonNullable<AgentStatus["subagents"]>[number]> = {}) {
  return { key: index.toString(16).padStart(16, "0"), agentType: null, description: null, activity: null, startedAtEpochMs: index, ...fields };
}

function status(subagents: NonNullable<AgentStatus["subagents"]>): AgentStatus {
  return { sessionId: "claude-1", status: "working", source: "hook", observedAtEpochMs: 1, subagents } as AgentStatus;
}

function render(session: Session, agentStatus: AgentStatus | undefined): string {
  return renderToStaticMarkup(createElement(SessionRowButton, {
    session,
    agentStatus,
    subtitle: "project",
    active: false,
    visible: false,
    menuOpen: false,
    select: () => {},
    openMenu: () => {},
  }));
}

describe("agent subagent rows", () => {
  it("lead with the task and trail with the current activity or role", () => {
    expect(agentSubagentRowText(subagent(1, { description: "Review the diff", agentType: "code-reviewer", activity: "Show the diff" })))
      .toEqual({ lead: "Review the diff", trail: "Show the diff" });
    expect(agentSubagentRowText(subagent(1, { description: "Review the diff", agentType: "code-reviewer" })))
      .toEqual({ lead: "Review the diff", trail: "Code reviewer" });
    expect(agentSubagentRowText(subagent(1, { agentType: "general-purpose" })))
      .toEqual({ lead: "General purpose", trail: "" });
    expect(agentSubagentRowText(subagent(1))).toEqual({ lead: "Subagent", trail: "" });
  });

  it("nest under a live agent row, collapse past three, and name the count", () => {
    const markup = render(agentSession(), status([1, 2, 3, 4, 5].map((index) => subagent(index, { description: `Child ${index}` }))));
    expect(markup).toContain('class="agent-subagents"');
    expect(markup).toContain("Child 3");
    expect(markup).not.toContain("Child 4");
    expect(markup).toContain("+2 more");
    expect(markup).toContain("5 subagents running");
  });

  it("stay hidden once the agent is no longer live", () => {
    const markup = render(agentSession("exited"), status([subagent(1, { description: "Child" })]));
    expect(markup).not.toContain("agent-subagents");
    expect(markup).not.toContain("subagents running");
    expect(render(agentSession(), status([]))).not.toContain("agent-subagents");
  });
});
