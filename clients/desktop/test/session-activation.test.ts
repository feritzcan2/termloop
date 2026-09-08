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
  let navigationRevision = 7;
  let projectPresent = true;
  let sessionPresent = false;
  const ports = {
    upsertSession: vi.fn(() => { sessionPresent = true; calls.push("upsert"); }),
    reconcileTerminals: vi.fn(() => { calls.push("reconcile"); }),
    refreshProject: vi.fn(async () => { calls.push("project"); }),
    refreshTasks: vi.fn(async () => { calls.push("task"); }),
    navigationRevision: vi.fn(() => navigationRevision),
    hasProject: vi.fn(() => projectPresent),
    hasSession: vi.fn(() => sessionPresent),
    reportRefreshFailure: vi.fn(() => { calls.push("warning"); }),
    selectProject: vi.fn(() => { calls.push("selectProject"); }),
    selectSession: vi.fn(() => { calls.push("selectSession"); }),
    focusSession: vi.fn(() => { calls.push("focus"); }),
  };
  const activation = createSessionActivation(ports);
  return {
    calls,
    ports,
    capture: activation.capture,
    activate: activation.activate,
    navigate: () => { navigationRevision += 1; },
    removeProject: () => { projectPresent = false; },
    removeSession: () => { sessionPresent = false; },
  };
}

describe("committed Session activation", () => {
  it("waits for the originating Project's full projection before revealing its terminal", async () => {
    const { calls, ports, capture, activate } = fixture();
    let release!: () => void;
    ports.refreshProject.mockImplementationOnce(() => new Promise<void>((resolve) => {
      calls.push("project");
      release = resolve;
    }));
    const activation = activate(capture(), session);
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
    const { calls, ports, capture, activate } = fixture();
    await activate(capture(), session, { kind: "task", taskId: "remote-task" });
    expect(ports.refreshTasks).toHaveBeenCalledWith(
      { projectId: "remote-project", connectionProfileId: "remote-computer" },
      ["remote-task"],
    );
    expect(ports.refreshProject).not.toHaveBeenCalled();
    expect(calls).toEqual(["upsert", "reconcile", "task", "selectProject", "selectSession", "focus"]);
  });

  it("reports refresh failure as a warning and still reveals the committed Session", async () => {
    const { ports, capture, activate, removeSession } = fixture();
    const failure = new Error("source disconnected");
    ports.refreshProject.mockImplementationOnce(async () => {
      removeSession();
      throw failure;
    });
    await activate(capture(), session);
    expect(ports.reportRefreshFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(ports.upsertSession).toHaveBeenCalledTimes(2);
    expect(ports.reconcileTerminals).toHaveBeenCalledTimes(2);
    expect(ports.selectSession).toHaveBeenCalledWith("remote-project", "remote-session");
    expect(ports.focusSession).toHaveBeenCalledWith("remote-session");
  });

  it("does not let a delayed activation override newer navigation", async () => {
    const { ports, capture, activate, navigate } = fixture();
    let release!: () => void;
    ports.refreshProject.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const activation = activate(capture(), session);
    navigate();
    release();
    await activation;
    expect(ports.selectProject).not.toHaveBeenCalled();
    expect(ports.selectSession).not.toHaveBeenCalled();
    expect(ports.focusSession).not.toHaveBeenCalled();
  });

  it("reveals only the newest concurrent launch intent", async () => {
    const { ports, capture, activate } = fixture();
    const first = capture();
    const second = capture();
    await activate(first, { ...session, id: "older-session" });
    expect(ports.focusSession).not.toHaveBeenCalled();
    await activate(second, session);
    expect(ports.focusSession).toHaveBeenCalledExactlyOnceWith("remote-session");
  });

  it("does not select a Project removed while its launch was completing", async () => {
    const { ports, capture, activate, removeProject } = fixture();
    const intent = capture();
    removeProject();
    await activate(intent, session);
    expect(ports.selectProject).not.toHaveBeenCalled();
    expect(ports.selectSession).not.toHaveBeenCalled();
    expect(ports.focusSession).not.toHaveBeenCalled();
  });
});
