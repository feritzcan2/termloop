import { describe, expect, it } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import {
  agentAttention,
  agentStatusTooltip,
  generatedInputDeliveryPresentation,
  presentedAgentStatus,
  sessionRowAccessibleName,
  sessionState,
} from "../src/renderer/session-presentation.js";
import type {
  AgentStatus as AgentStatusValue,
  GeneratedInputDeliveryFailure,
  GeneratedInputDeliveryState,
} from "@termloop/contract/current";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    project_id: "project-1",
    name: null,
    kind: "Agent",
    lifecycle_state: "running",
    runtime_epoch: 1,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
    ask_to_source_session_id: null,
    process: {
      program: "/usr/local/bin/codex",
      args: [],
      cwd: "/repo/.worktrees/work",
      agent_id: "codex",
      template_ref: null,
      template_version: null,
    },
    ...overrides,
  } as Session;
}

function status(value: AgentStatusValue, source: AgentStatus["source"] = "appServer"): AgentStatus {
  return { sessionId: "session-1", status: value, source, observedAtEpochMs: 1 };
}

function deliveryStatus(
  state: GeneratedInputDeliveryState,
  failure: GeneratedInputDeliveryFailure | null = null,
  overrides: Partial<NonNullable<AgentStatus["generatedInputDelivery"]>> = {},
): AgentStatus {
  return {
    ...status("unknown"),
    generatedInputDelivery: {
      state,
      failure,
      originalFailure: failure,
      cancelCause: null,
      cancelNotificationType: null,
      pasteReceipted: state !== "writingPaste",
      settlementEvidence: null,
      submitReceipted: state === "awaitingProviderAck" || state === "confirmed" || state === "confirmedUnattributed" || state === "stalled",
      submitAttempts: state === "awaitingProviderAck" || state === "confirmed" || state === "confirmedUnattributed" || state === "stalled" ? 1 : 0,
      protocolReplyWaits: 0,
      userInputMutated: null,
      outputChunks: 0,
      synchronizedFrames: 0,
      composerRenders: 0,
      completedComposerFrames: 0,
      composerSurfaceFrames: 0,
      composerCursorMoved: false,
      templateRef: "builtin.quick-action.free-prompt",
      templateVersion: 2,
      ...overrides,
    },
  };
}

/// Every member of the generated union, so a new contract status cannot reach a
/// user as a bare identifier the way `idle`, `interrupted`, and `unknown` did.
const agentStatusValues: AgentStatusValue[] = ["unknown", "working", "awaitingInput", "idle", "failed", "interrupted", "exited"];

describe("Session state", () => {
  it("surfaces every unconfirmed generated prompt state and stays silent after confirmation", () => {
    expect(sessionState(session(), deliveryStatus("writingPaste"), false)).toMatchObject({ id: "submittingPrompt", tone: "busy", label: "Waiting to submit" });
    expect(sessionState(session(), deliveryStatus("awaitingProviderAck"), false)).toMatchObject({ id: "submittingPrompt", tone: "busy" });
    expect(sessionState(session(), deliveryStatus("confirmedUnattributed"), false)).toMatchObject({ id: "promptUnattributed", tone: "attention", label: "Verify prompt" });
    expect(sessionState(session(), deliveryStatus("stalled", "providerAckMissing"), false)).toMatchObject({ id: "promptStalled", tone: "attention", label: "Prompt unconfirmed" });
    expect(sessionState(session(), deliveryStatus("blocked", "userInputInterleaved"), false)).toMatchObject({ id: "promptBlocked", tone: "attention", label: "Review prompt" });
    expect(sessionState(session(), deliveryStatus("blocked", "outputDidNotSettle"), false)).toMatchObject({ id: "promptBlocked", tone: "attention", label: "Press Enter" });
    expect(sessionState(session(), deliveryStatus("blocked", "composerUnavailable", { pasteReceipted: false }), false)).toMatchObject({ id: "promptBlocked", tone: "attention", label: "Waiting to submit" });
    expect(sessionState(session(), deliveryStatus("blocked", "composerUnavailable", { pasteReceipted: true }), false)).toMatchObject({ id: "promptBlocked", tone: "attention", label: "Resolve agent prompt" });
    expect(sessionState(session(), deliveryStatus("blocked", "composerNotReady", { pasteReceipted: false }), false)).toMatchObject({ id: "promptBlocked", tone: "attention", label: "Waiting to submit", summary: expect.stringContaining("did not paste") });
    expect(sessionState(session(), deliveryStatus("failed", "submitWriteFailed"), false)).toMatchObject({ id: "promptFailed", tone: "blocked", label: "Prompt failed" });
    expect(sessionState(session(), deliveryStatus("requiresUserResubmit"), false)).toMatchObject({ id: "promptRequiresResubmit", tone: "blocked", label: "Resubmit prompt" });
    expect(sessionState(session(), deliveryStatus("confirmed"), false)).toMatchObject({ id: "unobserved", label: undefined });
  });

  it("explains the exact unavailable-composer cause", () => {
    expect(generatedInputDeliveryPresentation(deliveryStatus(
      "blocked",
      "composerUnavailable",
      { pasteReceipted: false, cancelCause: "providerBusy" },
    ).generatedInputDelivery)).toMatchObject({
      state: {
        label: "Waiting to submit",
        summary: expect.stringContaining("had not returned to an available composer"),
      },
      detail: "agent had not returned to an available composer",
    });
    expect(generatedInputDeliveryPresentation(deliveryStatus(
      "blocked",
      "composerUnavailable",
      { pasteReceipted: false, cancelCause: "permissionRequested" },
    ).generatedInputDelivery)).toMatchObject({
      detail: "agent requested permission",
    });
  });

  it("presents only the exact acknowledged interruption as idle", () => {
    const interrupted = status("interrupted");
    expect(presentedAgentStatus(interrupted, new Map([[interrupted.sessionId, interrupted.observedAtEpochMs]]))).toMatchObject({
      status: "idle",
      observedAtEpochMs: interrupted.observedAtEpochMs,
      source: interrupted.source,
    });
    expect(presentedAgentStatus(interrupted, new Map([[interrupted.sessionId, interrupted.observedAtEpochMs - 1]]))).toBe(interrupted);
  });

  it("lets a stopped lifecycle shadow whatever its agent last claimed", () => {
    const exitedStatus = status("exited");
    expect(sessionState(session({ lifecycle_state: "resuming" }), exitedStatus, false)).toMatchObject({ id: "resuming", tone: "busy", label: "Resuming" });
    expect(sessionState(session({ lifecycle_state: "stale" }), exitedStatus, false)).toMatchObject({ id: "stale", tone: "quiet", label: "Stale" });
    expect(sessionState(session({ lifecycle_state: "exited" }), status("working"), false)).toMatchObject({ id: "processExited", tone: "blocked" });
  });

  it("separates a retryable resume failure from a terminal one", () => {
    const failed = { lifecycle_state: "resumeFailed" as const, resume_failure_reason: "cwdUnavailable" as const };
    expect(sessionState(session({ ...failed, retryable: true }), undefined, false)).toMatchObject({
      id: "retryable",
      tone: "blocked",
      label: "Retry available",
    });
    expect(sessionState(session({ ...failed, retryable: false }), undefined, false)).toMatchObject({
      id: "resumeFailed",
      label: "Resume failed",
    });
  });

  /// The shipped row printed `status.status` verbatim, so `idle`, `unknown`, and
  /// `interrupted` reached the user as bare lowercase identifiers beside
  /// sentence-case words. Every status now resolves to a written sentence, and no
  /// visible label is a raw contract member.
  it("maps every generated agent status to a written sentence rather than a contract member", () => {
    for (const value of agentStatusValues) {
      const state = sessionState(session(), status(value), false);
      expect(state.summary).toMatch(/^[A-Z].*\.$/u);
      expect(state.summary).not.toBe(value);
      /// The visible word is either a written phrase or nothing at all. It is
      /// never the wire member, which is what `idle`, `unknown`, and `interrupted`
      /// used to render as.
      expect(state.label === undefined || /^[A-Z]/u.test(state.label)).toBe(true);
      expect(state.label).not.toBe(value);
    }
  });

  it("stays silent for a resting or unobservable agent and speaks for every other state", () => {
    expect(sessionState(session(), status("idle"), false).label).toBeUndefined();
    expect(sessionState(session(), status("unknown"), false).label).toBeUndefined();
    expect(sessionState(session(), undefined, false)).toMatchObject({ id: "live", tone: "quiet", label: undefined });
    expect(sessionState(session(), status("working"), false)).toMatchObject({ label: "Working", tone: "working" });
    expect(sessionState(session(), status("awaitingInput"), false)).toMatchObject({ label: "Needs input", tone: "attention" });
    expect(sessionState(session(), status("interrupted"), false)).toMatchObject({ label: "Interrupted", tone: "interrupted" });
  });

  /// F2-16: the client-local review flag is only meaningful while the structured
  /// status is idle. The shipped row checked it ahead of every status, so an agent
  /// that resumed working still claimed to be waiting for review.
  it("honours review-ready only while the structured status is idle", () => {
    expect(sessionState(session(), status("idle"), true)).toMatchObject({ id: "review", tone: "review", label: "Needs review" });
    expect(sessionState(session(), status("working"), true)).toMatchObject({ id: "working", label: "Working" });
    expect(sessionState(session(), status("awaitingInput"), true)).toMatchObject({ id: "awaitingInput" });
  });
});

describe("Agent status tooltip", () => {
  /// tests/e2e/f1/agent-status.mjs asserts this exact shape on the presence dot.
  it("keeps the observation source and its asserted wording", () => {
    expect(agentStatusTooltip(status("idle"), false)).toBe("Idle · appServer");
    expect(agentStatusTooltip(status("idle"), true)).toBe("Ready for review · appServer");
    expect(agentStatusTooltip(status("awaitingInput", "hook"), false)).toBe("Awaiting input · hook");
    expect(agentStatusTooltip(status("working", "hook"), false)).toBe("Working · hook");
    expect(agentStatusTooltip(status("failed", "hook"), false)).toBe("Failed · hook");
  });

  it("is the only place the source appears, so row copy never leaks provenance", () => {
    for (const value of agentStatusValues) {
      expect(sessionState(session(), status(value), false).summary).not.toContain("appServer");
    }
  });
});

describe("Agent attention", () => {
  it("ranks waiting for input, then review, then working, and rests otherwise", () => {
    const agent = (id: string) => session({ id, name: id });
    const waiting = agent("waiting");
    const review = agent("review");
    const working = agent("working");
    const idle = agent("idle");
    const sessions = [working, idle, review, waiting];
    const statuses = new Map<string, AgentStatus>([
      [working.id, { ...status("working"), sessionId: working.id }],
      [idle.id, { ...status("idle"), sessionId: idle.id }],
      [review.id, { ...status("idle"), sessionId: review.id }],
      [waiting.id, { ...status("awaitingInput"), sessionId: waiting.id }],
    ]);

    expect(agentAttention(sessions, statuses, new Set([review.id]))).toEqual({
      sessionId: waiting.id,
      label: "Needs input",
      agent: "Codex",
      tone: "attention",
    });
    statuses.set(waiting.id, { ...status("idle"), sessionId: waiting.id });
    expect(agentAttention(sessions, statuses, new Set([review.id]))).toEqual({
      sessionId: review.id,
      label: "Needs review",
      agent: "Codex",
      tone: "review",
    });
    statuses.set(review.id, { ...status("idle"), sessionId: review.id });
    expect(agentAttention([working, idle], statuses, new Set())).toEqual({
      sessionId: working.id,
      label: "Working",
      agent: "Codex",
      tone: "working",
    });
    statuses.set(working.id, { ...status("working"), sessionId: working.id });
    expect(agentAttention([session({ id: working.id, kind: "Terminal" })], statuses, new Set())).toBeUndefined();
    statuses.set(working.id, { ...status("idle"), sessionId: working.id });
    expect(agentAttention([working, idle], statuses, new Set())).toBeUndefined();
  });

  it("ignores an agent whose lifecycle already stopped", () => {
    const stopped = session({ id: "stopped", lifecycle_state: "exited" });
    const statuses = new Map<string, AgentStatus>([[stopped.id, { ...status("working"), sessionId: stopped.id }]]);
    expect(agentAttention([stopped], statuses, new Set())).toBeUndefined();
  });
});

describe("Session row accessible name", () => {
  it("states identity, relationship, state, runner, then location", () => {
    expect(sessionRowAccessibleName({
      session: session({ name: "Claude helper" }),
      state: sessionState(session(), status("awaitingInput"), false),
      relationship: "from Primary Codex",
    })).toBe("Claude helper, from Primary Codex, Waiting for your input., Codex, /repo/.worktrees/work");
  });

  it("does not name the runner twice on an unnamed agent Session", () => {
    const name = sessionRowAccessibleName({
      session: session(),
      state: sessionState(session(), undefined, false),
      relationship: undefined,
    });
    expect(name).toBe("Codex, Running., /repo/.worktrees/work");
    expect(name.match(/Codex/gu)).toHaveLength(1);
  });

  it("names the program a terminal is running", () => {
    const terminal = session({ id: "term", kind: "Terminal", name: "build", process: { program: "/bin/zsh", args: [], cwd: "/repo", agent_id: null, template_ref: null, template_version: null } });
    expect(sessionRowAccessibleName({ session: terminal, state: sessionState(terminal, undefined, false), relationship: undefined }))
      .toBe("build, Running., zsh, /repo");
  });
});
