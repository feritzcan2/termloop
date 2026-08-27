import { describe, expect, it, vi } from "vitest";
import type { WorkerConfigurationDto } from "@termloop/contract/current";
import {
  restartStewardSession,
  restartWorkerSession,
  type StewardRestartApi,
  type WorkerRestartApi,
} from "../src/renderer/composition/worker-restart.js";

function worker(executorSessionId: string | null, enabled = true): WorkerConfigurationDto {
  return {
    id: "worker-1",
    projectId: "project-1",
    name: "Slack Worker",
    agentId: "codex",
    model: "gpt-5.6-sol",
    permission: "bypassPermissions",
    reasoning: "high",
    enabled,
    pingIntervalSeconds: 60,
    workerPrompt: "Handle Slack Routines",
    systemPrompt: "Reply briefly",
    executorSessionId,
    generation: 3,
    updatedAtEpochMs: 10,
  };
}

function api(overrides: Partial<WorkerRestartApi> = {}): WorkerRestartApi {
  return {
    workerConfigurationList: vi.fn().mockResolvedValue({ configurations: [worker("session-1")], stateRevision: 4 }),
    sessionTerminate: vi.fn().mockResolvedValue({ ok: true, result: {} }),
    workerConfigurationUpdate: vi.fn().mockResolvedValue({ configuration: worker("session-2"), stateRevision: 6 }),
    ...overrides,
  };
}

describe("Worker restart orchestration", () => {
  it("terminates the exact Session and relaunches from a fresh Worker snapshot", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ configurations: [worker("session-1")], stateRevision: 4 })
      .mockResolvedValueOnce({ configurations: [worker(null)], stateRevision: 5 })
      .mockResolvedValueOnce({ configurations: [worker("session-2")], stateRevision: 6 });
    const target = api({ workerConfigurationList: list });

    await expect(restartWorkerSession(target, "project-1", "worker-1")).resolves.toBe("session-2");

    expect(target.sessionTerminate).toHaveBeenCalledWith("session-1");
    expect(target.workerConfigurationUpdate).toHaveBeenCalledWith({
      workerId: "worker-1",
      name: "Slack Worker",
      agentId: "codex",
      model: "gpt-5.6-sol",
      permission: "bypassPermissions",
      reasoning: "high",
      enabled: true,
      pingIntervalSeconds: 60,
      workerPrompt: "Handle Slack Routines",
      systemPrompt: "Reply briefly",
      expectedRevision: 5,
    });
  });

  it("starts an enabled Worker that currently has no Session", async () => {
    const target = api({ workerConfigurationList: vi.fn()
      .mockResolvedValueOnce({ configurations: [worker(null)], stateRevision: 8 })
      .mockResolvedValueOnce({ configurations: [worker("session-2")], stateRevision: 9 }) });

    await expect(restartWorkerSession(target, "project-1", "worker-1")).resolves.toBe("session-2");

    expect(target.sessionTerminate).not.toHaveBeenCalled();
    expect(target.workerConfigurationUpdate).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 8 }));
  });

  it("does not launch after termination is refused", async () => {
    const target = api({
      sessionTerminate: vi.fn().mockResolvedValue({ ok: false, code: undefined, details: undefined, message: "busy" }),
    });

    await expect(restartWorkerSession(target, "project-1", "worker-1")).rejects.toThrow("busy");
    expect(target.workerConfigurationUpdate).not.toHaveBeenCalled();
  });

  it("refuses to restart a disabled Worker", async () => {
    const target = api({
      workerConfigurationList: vi.fn().mockResolvedValue({ configurations: [worker(null, false)], stateRevision: 3 }),
    });

    await expect(restartWorkerSession(target, "project-1", "worker-1")).rejects.toThrow("Enable the Worker");
  });
});

describe("Project Steward restart orchestration", () => {
  it("terminates the exact Session and relaunches from a fresh Steward snapshot", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ configuration: { projectId: "project-1", agentId: "claude", model: "sonnet", permission: "default", reasoning: "medium", systemPrompt: "PM", enabled: true, executorSessionId: "session-1", generation: 2, updatedAtEpochMs: 10 }, stateRevision: 4, supervisorAvailability: "online" })
      .mockResolvedValueOnce({ configuration: { projectId: "project-1", agentId: "claude", model: "sonnet", permission: "default", reasoning: "medium", systemPrompt: "PM", enabled: true, executorSessionId: null, generation: 2, updatedAtEpochMs: 11 }, stateRevision: 5, supervisorAvailability: "online" })
      .mockResolvedValueOnce({ configuration: { projectId: "project-1", agentId: "claude", model: "sonnet", permission: "default", reasoning: "medium", systemPrompt: "PM", enabled: true, executorSessionId: "session-2", generation: 2, updatedAtEpochMs: 12 }, stateRevision: 6, supervisorAvailability: "online" });
    const target: StewardRestartApi = {
      stewardConfigurationGet: get,
      stewardConfigurationSet: vi.fn().mockResolvedValue({}),
      sessionTerminate: vi.fn().mockResolvedValue({ ok: true, result: {} }),
    };

    await expect(restartStewardSession(target, "project-1")).resolves.toBe("session-2");
    expect(target.sessionTerminate).toHaveBeenCalledWith("session-1");
    expect(target.stewardConfigurationSet).toHaveBeenCalledWith({
      projectId: "project-1",
      agentId: "claude",
      model: "sonnet",
      permission: "default",
      reasoning: "medium",
      systemPrompt: "PM",
      enabled: true,
      expectedRevision: 5,
    });
  });

  it("starts an enabled Steward that currently has no Session", async () => {
    const target: StewardRestartApi = {
      stewardConfigurationGet: vi.fn()
        .mockResolvedValueOnce({ configuration: { projectId: "project-1", agentId: "codex", model: "gpt-5.6-sol", permission: "bypassPermissions", reasoning: "high", systemPrompt: "PM", enabled: true, executorSessionId: null, generation: 2, updatedAtEpochMs: 10 }, stateRevision: 7, supervisorAvailability: "online" })
        .mockResolvedValueOnce({ configuration: { projectId: "project-1", agentId: "codex", model: "gpt-5.6-sol", permission: "bypassPermissions", reasoning: "high", systemPrompt: "PM", enabled: true, executorSessionId: "session-2", generation: 2, updatedAtEpochMs: 11 }, stateRevision: 8, supervisorAvailability: "online" }),
      stewardConfigurationSet: vi.fn().mockResolvedValue({}),
      sessionTerminate: vi.fn(),
    };

    await expect(restartStewardSession(target, "project-1")).resolves.toBe("session-2");
    expect(target.sessionTerminate).not.toHaveBeenCalled();
    expect(target.stewardConfigurationSet).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7 }));
  });
});
