import type { AgentStatus, AgentStatusDto, SessionDto, SessionLifecycleState } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import {
  agentAttention,
  agentStatusIsLive,
  sessionProvenance,
  sessionRelationship,
  sessionRowAccessibleName,
  sessionState,
} from "../../src/presentation/session-presentation";
import { strongerTone, toneRank, type RowTone } from "../../src/presentation/tone";

/// The parity gate for the two literal ports.
///
/// `tone.ts` and `session-presentation.ts` are copies of the desktop's `row-tone.ts`
/// and `session-presentation.ts`. Clients may import only the generated contract, and
/// `common/`/`shared/`/`utils/` do not exist, so a shared package is not available and
/// the copies are held together by this table instead. The expected values below are
/// transcribed from the desktop module, not from the mobile one — if the mobile port
/// drifts, this fails; if the desktop table is intentionally changed, this fails and
/// the change is made deliberately on both surfaces.

function session(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: "ses_1",
    project_id: "prj_1",
    name: null,
    kind: "Agent",
    process: {
      program: "claude",
      args: [],
      cwd: "/Users/demo/Projects/termloop-next",
      agent_id: "claude",
      template_ref: null,
      template_version: null,
    },
    lifecycle_state: "running",
    runtime_epoch: 4,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: true,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    ...overrides,
  };
}

function status(value: AgentStatus): AgentStatusDto {
  return { sessionId: "ses_1", status: value, source: "hook", observedAtEpochMs: 1_000 };
}

describe("tone vocabulary parity with the desktop union", () => {
  it("ranks the eight tones in the desktop's ascending urgency", () => {
    const ascending: RowTone[] = [
      "quiet", "done", "working", "interrupted", "review", "busy", "attention", "blocked",
    ];
    expect(ascending.map(toneRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the louder of two tones, in either argument order", () => {
    expect(strongerTone("busy", "attention")).toBe("attention");
    expect(strongerTone("attention", "busy")).toBe("attention");
    /// A structural blocker outranks a waiting agent, and a waiting agent outranks an
    /// operation TermLoop started.
    expect(strongerTone("attention", "blocked")).toBe("blocked");
    expect(strongerTone("quiet", "quiet")).toBe("quiet");
  });
});

describe("session state parity with the desktop phrase table", () => {
  /// Every row is `[lifecycle, status, retryable, reviewReady] → [id, tone, label, summary]`.
  const table: readonly [
    SessionLifecycleState,
    AgentStatus | undefined,
    boolean,
    boolean,
    string,
    RowTone,
    string | undefined,
    string,
  ][] = [
    ["resuming", undefined, false, false, "resuming", "busy", "Resuming", "Resuming its existing conversation."],
    ["resumeFailed", undefined, true, false, "retryable", "blocked", "Retry available", "Its conversation could not resume, and a retry is available."],
    ["resumeFailed", undefined, false, false, "resumeFailed", "blocked", "Resume failed", "Its conversation could not resume."],
    ["stale", undefined, false, false, "stale", "quiet", "Stale", "Its terminal needs reopening."],
    ["exited", undefined, false, false, "processExited", "blocked", "Exited", "Its process exited."],
    ["running", undefined, false, false, "live", "quiet", undefined, "Running."],
    ["running", "awaitingInput", false, false, "awaitingInput", "attention", "Needs input", "Waiting for your input."],
    ["running", "idle", false, false, "idle", "quiet", undefined, "Idle."],
    ["running", "idle", false, true, "review", "review", "Needs review", "Ready for you to review."],
    ["running", "working", false, false, "working", "working", "Working", "Working now."],
    ["running", "compacting", false, false, "compacting", "working", "Compacting", "Summarizing its conversation to free up context."],
    ["running", "failed", false, false, "failed", "blocked", "Failed", "Its last turn failed."],
    ["running", "interrupted", false, false, "interrupted", "interrupted", "Interrupted", "Its last turn was interrupted."],
    ["running", "exited", false, false, "agentExited", "blocked", "Exited", "The agent reported that it exited."],
    ["running", "unknown", false, false, "unobserved", "quiet", undefined, "No agent status has been observed."],
  ];

  it.each(table)(
    "%s / %s / retryable %s / reviewReady %s resolves to %s",
    (lifecycle, agentStatus, retryable, reviewReady, id, tone, label, summary) => {
      const state = sessionState(
        session({ lifecycle_state: lifecycle, retryable }),
        agentStatus === undefined ? undefined : status(agentStatus),
        reviewReady,
      );
      expect(state).toEqual({ id, tone, label, summary });
    },
  );

  it("lets lifecycle shadow a status observed just before the process stopped", () => {
    /// A `working` status that outlived its process must not keep describing the row.
    const stopped = session({ lifecycle_state: "exited" });
    expect(agentStatusIsLive(stopped)).toBe(false);
    expect(sessionState(stopped, status("working"), false).id).toBe("processExited");
  });
});

describe("agent attention", () => {
  const statuses = new Map<string, AgentStatusDto>();

  it("prefers waiting for input over review, and review over working", () => {
    const working = session({ id: "ses_working" });
    const waiting = session({ id: "ses_waiting" });
    statuses.set("ses_working", { ...status("working"), sessionId: "ses_working" });
    statuses.set("ses_waiting", { ...status("awaitingInput"), sessionId: "ses_waiting" });

    /// Order in the list must not decide the winner.
    expect(agentAttention([working, waiting], statuses, new Set())?.tone).toBe("attention");
    expect(agentAttention([waiting, working], statuses, new Set())?.tone).toBe("attention");

    const idle = session({ id: "ses_idle" });
    statuses.set("ses_idle", { ...status("idle"), sessionId: "ses_idle" });
    expect(agentAttention([working, idle], statuses, new Set(["ses_idle"]))?.tone).toBe("review");
    expect(agentAttention([working, idle], statuses, new Set())?.tone).toBe("working");
  });

  it("ignores terminals and sessions whose lifecycle is not running", () => {
    const terminal = session({ id: "ses_term", kind: "Terminal" });
    const stopped = session({ id: "ses_stopped", lifecycle_state: "exited" });
    statuses.set("ses_term", { ...status("awaitingInput"), sessionId: "ses_term" });
    statuses.set("ses_stopped", { ...status("awaitingInput"), sessionId: "ses_stopped" });
    expect(agentAttention([terminal, stopped], statuses, new Set())).toBeUndefined();
  });
});

describe("row provenance and accessible names", () => {
  it("drops provenance the identity line already stated", () => {
    /// An unnamed Claude session is titled "Claude", so repeating the runner would spend
    /// the row's narrowest line on a word already read.
    expect(sessionProvenance(session(), "termloop-next")).toEqual({
      runner: undefined,
      folder: "termloop-next",
    });
    expect(sessionProvenance(session({ name: "Mobile work" }), "Mobile work")).toEqual({
      runner: "Claude",
      folder: undefined,
    });
  });

  it("names a terminal by its program rather than its agent", () => {
    const terminal = session({
      id: "ses_term",
      kind: "Terminal",
      process: { ...session().process, program: "/bin/zsh", agent_id: null },
    });
    expect(sessionProvenance(terminal, "termloop-next").runner).toBe("zsh");
  });

  it("states an Ask-To relation without inventing session parentage", () => {
    const source = session({ id: "ses_source", name: "Mobile architecture" });
    const helper = session({ id: "ses_helper", ask_to_source_session_id: "ses_source" });
    const byId = new Map([[source.id, source]]);
    expect(sessionRelationship(helper, byId)).toBe("helping Mobile architecture");
    /// A source that is no longer in the projection still gets an honest label rather
    /// than a dangling reference.
    expect(sessionRelationship(helper, new Map())).toBe("helper session");
    expect(sessionRelationship(source, byId)).toBeUndefined();
  });

  it("reads a row as one sentence in the design's ranked order", () => {
    const subject = session({ name: "Mobile work" });
    const state = sessionState(subject, status("awaitingInput"), false);
    expect(sessionRowAccessibleName({ session: subject, state, relationship: undefined })).toBe(
      "Mobile work, Waiting for your input., Claude, /Users/demo/Projects/termloop-next",
    );
  });
});
