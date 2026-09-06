import { describe, expect, it, vi } from "vitest";
import {
  restartStewardSession,
  type StewardRestartApi,
} from "../src/renderer/composition/steward-restart.js";

describe("Project Steward restart orchestration", () => {
  it("terminates the exact Session and relaunches from a fresh Steward snapshot", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ configuration: { projectId: "project-1", agentId: "claude", model: "sonnet", permission: "default", reasoning: "medium", systemPrompt: "PM", enabled: true, executorSessionId: "session-1", generation: 2, updatedAtEpochMs: 10 }, stateRevision: 4, supervisorAvailability: "online" })
      .mockResolvedValueOnce({ configuration: { projectId: "project-1", agentId: "claude", model: "sonnet", permission: "default", reasoning: "medium", systemPrompt: "PM", enabled: true, executorSessionId: null, generation: 2, updatedAtEpochMs: 11 }, stateRevision: 5, supervisorAvailability: "online" })
      .mockResolvedValueOnce({ configuration: { projectId: "project-1", agentId: "claude", model: "sonnet", permission: "default", reasoning: "medium", systemPrompt: "PM", enabled: true, executorSessionId: "session-2", generation: 2, updatedAtEpochMs: 12 }, stateRevision: 6, supervisorAvailability: "online" });
    const target: StewardRestartApi = {
      stewardConfigurationGet: get,
      stewardConfigurationSet: vi.fn().mockResolvedValue({}),
      sessionClose: vi.fn().mockResolvedValue({ sessionId: "session-1", closed: true }),
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
      sessionClose: vi.fn(),
      sessionTerminate: vi.fn(),
    };

    await expect(restartStewardSession(target, "project-1")).resolves.toBe("session-2");
    expect(target.sessionTerminate).not.toHaveBeenCalled();
    expect(target.stewardConfigurationSet).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7 }));
  });
});
