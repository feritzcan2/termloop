import { describe, expect, it, vi } from "vitest";
import { createSessionActivation } from "../src/renderer/composition/session-activation.js";
import type { Session } from "../src/renderer/model.js";

const session = {
  id: "remote-session",
  project_id: "remote-project",
  connectionProfileId: "remote-computer",
} as Session;

function fixture() {
  const calls: string[] = [];
  const ports = {
    upsertSession: vi.fn(() => { calls.push("upsert"); }),
    reconcileTerminals: vi.fn(() => { calls.push("reconcile"); }),
    refreshProject: vi.fn(async () => { calls.push("project"); }),
    refreshTasks: vi.fn(async () => { calls.push("task"); }),
    selectProject: vi.fn(() => { calls.push("selectProject"); }),
    selectSession: vi.fn(() => { calls.push("selectSession"); }),
    focusSession: vi.fn(() => { calls.push("focus"); }),
  };
  return { calls, ports, activate: createSessionActivation(ports) };
}

describe("committed Session activation", () => {
  it("waits for the originating Project's full projection before revealing its terminal", async () => {
    const { calls, ports, activate } = fixture();
    let release!: () => void;
    ports.refreshProject.mockImplementationOnce(() => new Promise<void>((resolve) => {
      calls.push("project");
      release = resolve;
    }));
    const activation = activate(session);
    expect(calls).toEqual(["upsert", "reconcile", "project"]);
    expect(ports.refreshProject).toHaveBeenCalledWith({ projectId: "remote-project", connectionProfileId: "remote-computer" });
    expect(ports.refreshTasks).not.toHaveBeenCalled();
    release();
    await activation;
    expect(calls).toEqual(["upsert", "reconcile", "project", "selectProject", "selectSession", "focus"]);
    expect(ports.selectSession).toHaveBeenCalledWith("remote-project", "remote-session");
    expect(ports.focusSession).toHaveBeenCalledWith("remote-session");
  });

  it("keeps a Task refresh bound to the returned Session's Project and source", async () => {
    const { calls, ports, activate } = fixture();
    await activate(session, { kind: "task", taskId: "remote-task" });
    expect(ports.refreshTasks).toHaveBeenCalledWith(
      { projectId: "remote-project", connectionProfileId: "remote-computer" },
      ["remote-task"],
    );
    expect(ports.refreshProject).not.toHaveBeenCalled();
    expect(calls).toEqual(["upsert", "reconcile", "task", "selectProject", "selectSession", "focus"]);
  });

  it("keeps a committed Session installed on refresh failure without revealing or resubmitting it", async () => {
    const { ports, activate } = fixture();
    const failure = new Error("source disconnected");
    ports.refreshProject.mockRejectedValueOnce(failure);
    await expect(activate(session)).rejects.toBe(failure);
    expect(ports.upsertSession).toHaveBeenCalledExactlyOnceWith(session);
    expect(ports.reconcileTerminals).toHaveBeenCalledTimes(1);
    expect(ports.selectProject).not.toHaveBeenCalled();
    expect(ports.selectSession).not.toHaveBeenCalled();
    expect(ports.focusSession).not.toHaveBeenCalled();
  });
});
