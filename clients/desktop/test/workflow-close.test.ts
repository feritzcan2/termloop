import { describe, expect, it, vi } from "vitest";
import type { Session, WorkflowExecution } from "../src/renderer/model.js";
import { closeWorkflowAgents } from "../src/renderer/composition/workflow-close.js";
import { workflowConfiguration } from "./workflow-fixture.js";

function agent(id: string, overrides: Partial<Session> = {}): Session {
  return { id, project_id: "project-1", name: id, kind: "Agent", lifecycle_state: "running", runtime_epoch: 1,
    archived_at_epoch_ms: null, resume_failure_reason: null, retryable: false, closable: false, forkable: false,
    ask_to_source_session_id: null, run_configuration_id: null,
    process: { program: "codex", args: [], cwd: "/repo", agent_id: "codex", template_ref: "builtin.agent.interactive", template_version: 1 },
    ...overrides } as Session;
}

function fixture() {
  const state: { execution: WorkflowExecution | undefined; sessions: Session[]; revision: number } = {
    execution: { id: "run", projectId: "project-1", taskId: null, workflowId: "workflow-1", workflowGeneration: 1,
      workflowName: "Build and verify", goal: "Test", coordinatorSessionId: "lead", currentStepIndex: 0, reviewCycle: 1,
      maxReviewCycles: 2, phase: "awaitingHelper", status: "running", completionOutcome: null,
      steps: workflowConfiguration().steps,
      participants: [{ stepId: "discuss", sessionId: "helper" }, { stepId: "review", sessionId: "helper" }, { stepId: "review-2", sessionId: "second" }],
      activeReviewStepIds: [], pendingReviewStepIds: [], stepResults: [], startedAtEpochMs: 1, updatedAtEpochMs: 1 },
    sessions: [agent("lead"), agent("helper", { ask_to_source_session_id: "lead" }), agent("second"), agent("ordinary", { name: "Build and verify", ask_to_source_session_id: "lead" })],
    revision: 10,
  };
  const calls: string[] = [];
  const api = {
    workflowConfigurationList: vi.fn(async (_params: { projectId: string }) => ({ configurations: [], executions: state.execution ? [structuredClone(state.execution)] : [], stateRevision: state.revision })),
    sessionList: vi.fn(async () => structuredClone(state.sessions)),
    sessionTerminate: vi.fn(async (id: string) => {
      calls.push(`stop:${id}`); state.revision++;
      state.sessions = state.sessions.map((session) => session.id === id ? { ...session, lifecycle_state: "exited", closable: true } : session);
      return { ok: true as const, result: {} };
    }),
    sessionClose: vi.fn(async (id: string) => {
      calls.push(`close:${id}`); state.revision++;
      state.sessions = state.sessions.filter((session) => session.id !== id);
      return { sessionId: id, closed: true };
    }),
    workflowExecutionCancel: vi.fn(async (params: { executionId: string; expectedRevision: number }) => {
      expect(params).toEqual({ executionId: "run", expectedRevision: state.revision });
      calls.push("cancel"); state.execution = undefined; state.revision++;
      return { executionId: "run", cancelled: true as const, stateRevision: state.revision };
    }),
  };
  return { state, api, calls, close: () => closeWorkflowAgents(api, "project-1", "run") };
}

describe("close all workflow agents", () => {
  it.each(["running", "completed"] as const)("closes the exact %s group, lead first, without touching matching names, checkouts or ordinary helpers", async (status) => {
    const f = fixture(); f.state.execution!.status = status;
    await f.close();
    expect(f.calls.slice(0, 2)).toEqual(["stop:lead", "close:lead"]);
    expect(f.api.sessionClose.mock.calls.flat()).toEqual(["lead", "helper", "second"]);
    expect(f.calls.at(-1)).toBe("cancel");
    expect(f.state.sessions.map((session) => session.id)).toEqual(["ordinary"]);
    expect(f.api.workflowConfigurationList).toHaveBeenCalledWith({ projectId: "project-1" });
  });
  it("includes a helper admitted while the lead was stopping", async () => {
    const f = fixture(); const stop = f.api.sessionTerminate.getMockImplementation()!;
    f.api.sessionTerminate.mockImplementation(async (id) => {
      if (id === "lead") {
        f.state.execution!.participants.push({ stepId: "late-review", sessionId: "late" });
        f.state.sessions.push(agent("late"));
      }
      return stop(id);
    });
    await f.close();
    expect(f.api.sessionClose).toHaveBeenCalledWith("late");
  });
  it("closes stopped members without terminating them and leaves archived conversations alone", async () => {
    const f = fixture();
    f.state.sessions = f.state.sessions.map((session) => ({ ...session, lifecycle_state: "stale", closable: true,
      archived_at_epoch_ms: session.id === "second" ? 1 : null }));
    await f.close();
    expect(f.api.sessionTerminate).not.toHaveBeenCalled();
    expect(f.api.sessionClose.mock.calls.flat()).toEqual(["lead", "helper"]);
  });
  it("stops before touching helpers when closing the lead fails", async () => {
    const f = fixture(); f.api.sessionTerminate.mockRejectedValueOnce(new Error("Busy"));
    await expect(f.close()).rejects.toThrow("Busy");
    expect(f.api.sessionClose).not.toHaveBeenCalled();
    expect(f.api.workflowExecutionCancel).not.toHaveBeenCalled();
  });
  it("keeps the run on a partial failure and retries only the remaining agents", async () => {
    const f = fixture(); const stop = f.api.sessionTerminate.getMockImplementation()!;
    f.api.sessionTerminate.mockImplementation(async (id) => { if (id === "helper") throw new Error("Busy"); return stop(id); });
    await expect(f.close()).rejects.toThrow("Retry to close the remaining agents");
    expect(f.api.workflowExecutionCancel).not.toHaveBeenCalled();
    expect(f.state.sessions.map((session) => session.id)).toEqual(["helper", "ordinary"]);
    f.api.sessionTerminate.mockImplementation(stop);
    await f.close();
    expect(f.api.sessionClose.mock.calls.flat()).toEqual(["lead", "second", "helper"]);
    expect(f.api.workflowExecutionCancel).toHaveBeenCalledTimes(1);
  });
  it("does not silently skip an agent that the daemon cannot close", async () => {
    const f = fixture(); f.state.sessions[1] = agent("helper", { lifecycle_state: "stale", closable: false });
    await expect(f.close()).rejects.toThrow("cannot be closed yet");
    expect(f.api.workflowExecutionCancel).not.toHaveBeenCalled();
  });
  it("can retry cancellation after all descriptors closed without repeating termination", async () => {
    const f = fixture(); f.api.workflowExecutionCancel.mockRejectedValueOnce(new Error("Revision conflict"));
    await expect(f.close()).rejects.toThrow("Revision conflict");
    await f.close();
    expect(f.api.sessionTerminate).toHaveBeenCalledTimes(3);
    expect(f.api.workflowExecutionCancel).toHaveBeenCalledTimes(2);
  });
  it.each(["execution", "member"])("rejects cross-project %s data before mutation", async (field) => {
    const f = fixture();
    if (field === "execution") f.state.execution!.projectId = "other";
    else f.state.sessions[1]!.project_id = "other";
    await expect(f.close()).rejects.toThrow();
    expect(f.api.sessionTerminate).not.toHaveBeenCalled();
    expect(f.api.sessionClose).not.toHaveBeenCalled();
  });
  it("does not guess members after the execution disappears", async () => {
    const f = fixture(); f.state.execution = undefined;
    await expect(f.close()).rejects.toThrow("no longer available");
    expect(f.api.sessionTerminate).not.toHaveBeenCalled();
  });
  it("preserves the run if another client restores an agent before final cancellation", async () => {
    const f = fixture(); let reads = 0;
    f.api.sessionList.mockImplementation(async () => {
      if (++reads === 3) f.state.sessions.push(agent("lead"));
      return structuredClone(f.state.sessions);
    });
    await expect(f.close()).rejects.toThrow("new or reopened agents");
    expect(f.api.workflowExecutionCancel).not.toHaveBeenCalled();
  });
});
