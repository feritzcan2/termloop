import { describe, expect, it } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { isLiveSession, sessionDismissCommand, sessionIsImprover, sessionKeepsTerminalSurface, sessionLabel, sessionResumeActionLabel } from "../src/renderer/model.js";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
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
      cwd: "/Users/demo/termloop-next",
      agent_id: null,
      template_ref: null,
      template_version: null,
    },
    ...overrides,
  };
}

describe("Session presentation projections", () => {
  it("prefers a user name and falls back without persisting a display label", () => {
    const first = session();
    expect(sessionLabel(first)).toBe("termloop-next");
    expect(sessionLabel({ ...first, name: "API shell" })).toBe("API shell");
    expect(sessionLabel({ ...first, kind: "Agent", process: { ...first.process, agent_id: "codex" } })).toBe("Codex");
    expect(sessionLabel({ ...first, kind: "Agent", name: "My Agent", process: { ...first.process, agent_id: "codex" } })).toBe("My Agent");
    expect(sessionLabel({ ...first, kind: "Agent", process: { ...first.process, agent_id: "claude" } })).toBe("Claude");
  });

  it("terminates a live Session and closes a stopped descriptor the daemon reports closable", () => {
    expect(sessionDismissCommand(session({ lifecycle_state: "running" }))).toBe("terminate");
    expect(sessionDismissCommand(session({ lifecycle_state: "resuming" }))).toBe("terminate");
    for (const state of ["exited", "stale", "resumeFailed"] as const) {
      expect(sessionDismissCommand(session({ lifecycle_state: state, closable: true }))).toBe("close");
    }
  });

  it("counts only Sessions that are actually live", () => {
    expect(isLiveSession(session({ lifecycle_state: "running" }))).toBe(true);
    expect(isLiveSession(session({ lifecycle_state: "resuming" }))).toBe(true);
    for (const state of ["exited", "stale", "resumeFailed"] as const) {
      expect(isLiveSession(session({ lifecycle_state: state }))).toBe(false);
    }
  });

  it("keeps every current terminal surface after process exit until the user archives or closes it", () => {
    for (const state of ["running", "resuming", "exited", "stale", "resumeFailed"] as const) {
      expect(sessionKeepsTerminalSurface(session({ lifecycle_state: state }))).toBe(true);
    }
    expect(sessionKeepsTerminalSurface(session({
      lifecycle_state: "exited",
      archived_at_epoch_ms: 1,
    }))).toBe(false);
  });

  it("offers Retry after both a normal exit and a failed attempt", () => {
    expect(sessionResumeActionLabel(session({
      kind: "Agent",
      lifecycle_state: "exited",
      retryable: true,
    }))).toBe("Retry");
    expect(sessionResumeActionLabel(session({
      kind: "Agent",
      lifecycle_state: "resumeFailed",
      retryable: true,
    }))).toBe("Retry");
    expect(sessionResumeActionLabel(session({ lifecycle_state: "exited" }))).toBeUndefined();
  });

  it("terminates a retryable ownership failure before closing its descriptor", () => {
    expect(sessionDismissCommand(session({
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "runtimeOwnershipUncertain",
      retryable: true,
      closable: false,
    }))).toBe("terminate");
  });

  it("offers nothing for a non-retryable stopped Session the daemon refuses to close", () => {
    expect(sessionDismissCommand(session({
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "resumeRefMissing",
      retryable: false,
      closable: false,
    }))).toBeUndefined();
  });

  it("identifies Playbook and Routine Builders as improvers for presentation", () => {
    for (const template_ref of ["builtin.builder.playbook", "builtin.builder.routine"]) {
      const builder = session({
        kind: "Agent",
        process: {
          ...session().process,
          agent_id: "claude",
          template_ref,
          template_version: 1,
        },
      });
      expect(sessionIsImprover(builder)).toBe(true);
      expect(sessionDismissCommand(builder)).toBe("terminate");
      expect(sessionDismissCommand({ ...builder, lifecycle_state: "exited", closable: true })).toBe("close");
    }
  });
});
