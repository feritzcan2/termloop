import { describe, expect, it } from "vitest";

import {
  fixtureAgentCapabilities,
  fixtureSessions,
  fixtureTasks,
} from "../../src/fixtures/mobile-overview";
import {
  relocationBlockerMessage,
  relocationWarningMessage,
  sessionActionPresentation,
  sessionDismissAction,
} from "../../src/presentation/session-actions-presentation";

const source = {
  ...fixtureSessions[0]!,
  process: {
    ...fixtureSessions[0]!.process,
    template_ref: "builtin.agent.interactive",
  },
};

describe("mobile Session actions", () => {
  it("offers desktop-equivalent Agent coordination and Project relocation for an attached Agent", () => {
    const handover = {
      ...source,
      id: "session-codex",
      name: "Reviewer",
      process: { ...source.process, agent_id: "codex", program: "codex" },
    };
    const presentation = sessionActionPresentation(
      source,
      [source, handover],
      fixtureTasks,
      fixtureAgentCapabilities,
    );

    expect(presentation.coordination?.askTargets.map((target) => target.agentId)).toEqual(["claude", "codex"]);
    expect(presentation.coordination?.handoverTargets.map((target) => target.id)).toEqual([handover.id]);
    expect(presentation.canRefresh).toBe(true);
    expect(presentation.canFork).toBe(true);
    expect(presentation.canRelocateToProject).toBe(true);
    expect(presentation.taskRelocationTargets).toEqual([]);
  });

  it("offers open Tasks only while an ordinary Agent is in the Project checkout", () => {
    const detachedTask = {
      ...fixtureTasks[0]!,
      worktree_presence: {
        ...fixtureTasks[0]!.worktree_presence!,
        attached_sessions: [],
        total_count: 0,
        agent_count: 0,
      },
    };
    const presentation = sessionActionPresentation(
      source,
      [source],
      [detachedTask],
      fixtureAgentCapabilities,
    );

    expect(presentation.attachedTask).toBeUndefined();
    expect(presentation.taskRelocationTargets.map((task) => task.id)).toEqual([detachedTask.id]);
    expect(presentation.canRelocateToProject).toBe(false);
  });

  it("does not offer moving an Ask-To helper into another Task", () => {
    const helper = { ...source, ask_to_source_session_id: "session-source" };
    const presentation = sessionActionPresentation(
      helper,
      [helper],
      fixtureTasks,
      fixtureAgentCapabilities,
    );

    expect(presentation.taskRelocationTargets).toEqual([]);
    expect(presentation.canRelocateToProject).toBe(true);
  });

  it("offers Fix-and-retry for provider history damage and Retry for other recoverable failures", () => {
    expect(sessionActionPresentation({
      ...source,
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "providerHistoryDamaged",
      retryable: true,
    }, [source], fixtureTasks, fixtureAgentCapabilities).recovery).toEqual({
      kind: "repairAndRetry",
      label: "Fix",
      detail: "Repair provider history and retry this Agent",
    });
    expect(sessionActionPresentation({
      ...source,
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "resumeRejected",
      retryable: true,
    }, [source], fixtureTasks, fixtureAgentCapabilities).recovery).toMatchObject({
      kind: "retry",
      label: "Retry",
    });
  });

  it("maps one close intent to terminate-then-close or direct descriptor removal", () => {
    expect(sessionDismissAction(source)).toMatchObject({
      command: "terminate",
      label: "Close Session",
    });
    expect(sessionDismissAction({ ...source, lifecycle_state: "exited", closable: true })).toMatchObject({
      command: "close",
      label: "Remove Session",
    });
    expect(sessionDismissAction({ ...source, lifecycle_state: "stale", closable: false })).toBeUndefined();
  });

  it("turns relocation contract facts into readable messages", () => {
    expect(relocationBlockerMessage("askToInProgress")).toContain("Ask-To");
    expect(relocationWarningMessage("sourceTurnWillBeInterrupted")).toContain("interrupted");
  });
});
