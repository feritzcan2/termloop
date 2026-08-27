import { describe, expect, it, vi } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { dismissSessionDescriptor } from "../src/renderer/composition/session-dismiss.js";

function session(lifecycleState: Session["lifecycle_state"], closable: boolean): Session {
  return {
    id: "session-1",
    project_id: "project-1",
    name: null,
    kind: "Agent",
    lifecycle_state: lifecycleState,
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    retryable: false,
    closable,
    forkable: false,
    process: {
      program: "codex",
      args: [],
      cwd: "/project",
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: 1,
    },
  };
}

function improver(lifecycleState: Session["lifecycle_state"]): Session {
  const value = session(lifecycleState, lifecycleState === "exited");
  return {
    ...value,
    name: "improve: Deploy check",
    retryable: lifecycleState === "exited",
    process: {
      ...value.process,
      template_ref: "builtin.improver.routine-instructions",
    },
    improver_target: { targetKind: "routineInstructions", targetId: "routine-1" },
  };
}

describe("Session dismissal", () => {
  it("terminates and closes a live Session in one user intent", async () => {
    const order: string[] = [];
    const api = {
      sessionTerminate: vi.fn(async () => { order.push("terminate"); return { ok: true as const, result: {} }; }),
      sessionClose: vi.fn(async () => { order.push("close"); return { sessionId: "session-1", closed: true }; }),
    };

    await dismissSessionDescriptor(api, session("running", false));

    expect(order).toEqual(["terminate", "close"]);
  });

  it("closes an already stopped Session without terminating it again", async () => {
    const api = {
      sessionTerminate: vi.fn(),
      sessionClose: vi.fn(async () => ({ sessionId: "session-1", closed: true })),
    };

    await dismissSessionDescriptor(api, session("exited", true));

    expect(api.sessionTerminate).not.toHaveBeenCalled();
    expect(api.sessionClose).toHaveBeenCalledWith("session-1");
  });

  it("recovers a retryable ownership failure before closing it", async () => {
    const order: string[] = [];
    const api = {
      sessionTerminate: vi.fn(async () => { order.push("terminate"); return { ok: true as const, result: {} }; }),
      sessionClose: vi.fn(async () => { order.push("close"); return { sessionId: "session-1", closed: true }; }),
    };
    const retryable = {
      ...session("resumeFailed", false),
      resume_failure_reason: "runtimeOwnershipUncertain" as const,
      retryable: true,
    };

    await dismissSessionDescriptor(api, retryable);

    expect(order).toEqual(["terminate", "close"]);
  });

  it("does not delete the descriptor when termination is refused", async () => {
    const api = {
      sessionTerminate: vi.fn(async () => ({
        ok: false as const,
        code: undefined,
        details: undefined,
        message: "busy",
      })),
      sessionClose: vi.fn(),
    };

    await expect(dismissSessionDescriptor(api, session("running", false))).rejects.toThrow("busy");
    expect(api.sessionClose).not.toHaveBeenCalled();
  });

  it("terminates and closes a live improver", async () => {
    const api = {
      sessionTerminate: vi.fn(async () => ({ ok: true as const, result: {} })),
      sessionClose: vi.fn(async () => ({ sessionId: "session-1", closed: true })),
    };

    await dismissSessionDescriptor(api, improver("running"));

    expect(api.sessionTerminate).toHaveBeenCalledWith("session-1");
    expect(api.sessionClose).toHaveBeenCalledWith("session-1");
  });

  it("closes an already stopped improver", async () => {
    const api = {
      sessionTerminate: vi.fn(),
      sessionClose: vi.fn(async () => ({ sessionId: "session-1", closed: true })),
    };

    await dismissSessionDescriptor(api, improver("exited"));

    expect(api.sessionTerminate).not.toHaveBeenCalled();
    expect(api.sessionClose).toHaveBeenCalledWith("session-1");
  });

  it("terminates and closes a Playbook Builder", async () => {
    const api = {
      sessionTerminate: vi.fn(async () => ({ ok: true as const, result: {} })),
      sessionClose: vi.fn(async () => ({ sessionId: "session-1", closed: true })),
    };
    const builder = {
      ...improver("running"),
      name: "build: Project Playbook",
      process: {
        ...improver("running").process,
        template_ref: "builtin.builder.playbook",
      },
      improver_target: { targetKind: "playbook" as const, targetId: null },
    };

    await dismissSessionDescriptor(api, builder);

    expect(api.sessionTerminate).toHaveBeenCalledWith("session-1");
    expect(api.sessionClose).toHaveBeenCalledWith("session-1");
  });
});
