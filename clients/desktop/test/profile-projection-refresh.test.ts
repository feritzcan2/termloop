import { describe, expect, it, vi } from "vitest";

import { ProfileProjectionRefresh } from "../src/renderer/composition/profile-projection-refresh.js";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { KeyedProjectionRefreshQueue } from "../src/renderer/state/projection-refresh.js";
import { ProjectionStore } from "../src/renderer/state/projection-store.js";
import { activeAgentSections } from "../src/renderer/ui/ActiveAgentRail.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("profile projection refresh", () => {
  it("moves an idle Agent into progress while the previous worktree read is pending", async () => {
    const store = new ProjectionStore();
    const session = {
      id: "agent-1", project_id: "project-1", name: "Agent", kind: "Agent",
      lifecycle_state: "running", process: { agent_id: "codex" },
    } as Session;
    let observedStatus: AgentStatus["status"] = "idle";
    const worktree = deferred();
    const readProject = vi.fn(async () => {
      await worktree.promise;
      store.applySelectedProjectSnapshot("project-1", []);
    });
    const projects = new KeyedProjectionRefreshQueue(readProject);
    const refresh = new ProfileProjectionRefresh(
      async () => store.applySourceSnapshot("local", "This computer", [], [session], [{
        sessionId: session.id, status: observedStatus, source: "appServer", observedAtEpochMs: 1,
      }]),
      (profileId) => projects.request(profileId),
    );
    const section = () => {
      const snapshot = store.getSnapshot();
      return activeAgentSections(
        snapshot.sessions,
        new Map(snapshot.agentStatuses.map((status) => [status.sessionId, status])),
        new Set(), new Set(), 100,
      );
    };

    const first = refresh.request("local");
    await vi.waitFor(() => expect(readProject).toHaveBeenCalledOnce());
    expect(section().resting.map((agent) => agent.id)).toEqual([session.id]);

    observedStatus = "working";
    let completed = false;
    const second = refresh.request("local").then(() => { completed = true; });
    await vi.waitFor(() => expect(section().inProgress.map((agent) => agent.id)).toEqual([session.id]));
    expect(section().resting).toEqual([]);
    expect(completed).toBe(false);

    worktree.resolve();
    await Promise.all([first, second]);
    expect(completed).toBe(true);
    expect(section().inProgress.map((agent) => agent.id)).toEqual([session.id]);
  });

  it("serializes source snapshots so an older idle response cannot overwrite working", async () => {
    const oldSnapshot = deferred();
    const statuses: string[] = [];
    const readSource = vi.fn()
      .mockImplementationOnce(async () => {
        await oldSnapshot.promise;
        statuses.push("idle");
      })
      .mockImplementation(async () => { statuses.push("working"); });
    const refresh = new ProfileProjectionRefresh(readSource, async () => {});
    const first = refresh.request("local");
    await vi.waitFor(() => expect(readSource).toHaveBeenCalledOnce());

    const second = refresh.request("local");
    const third = refresh.request("local");
    expect(readSource).toHaveBeenCalledOnce();
    oldSnapshot.resolve();
    await Promise.all([first, second, third]);

    expect(statuses).toEqual(["idle", "working"]);
    expect(readSource).toHaveBeenCalledTimes(2);
  });

  it("refreshes peer sources while a remote source read is pending", async () => {
    const remote = deferred();
    const readSource = vi.fn(async (profileId: string) => {
      if (profileId === "remote") await remote.promise;
    });
    const readProject = vi.fn(async () => {});
    const refresh = new ProfileProjectionRefresh(readSource, readProject);
    const first = refresh.request("remote");

    await refresh.request("local");
    expect(readProject.mock.calls).toEqual([["local"]]);

    remote.resolve();
    await first;
    expect(readProject.mock.calls).toEqual([["local"], ["remote"]]);
  });

  it("reports a failed project read without blocking later status reads", async () => {
    const project = deferred();
    const readSource = vi.fn(async () => {});
    const readProject = vi.fn()
      .mockImplementationOnce(() => project.promise)
      .mockImplementation(async () => {});
    const refresh = new ProfileProjectionRefresh(readSource, readProject);
    const failed = expect(refresh.request("local")).rejects.toThrow("worktree unavailable");
    await vi.waitFor(() => expect(readProject).toHaveBeenCalledOnce());

    await refresh.request("local");
    expect(readSource).toHaveBeenCalledTimes(2);
    project.reject(new Error("worktree unavailable"));
    await failed;
  });

  it("reports source failure before reading project details and allows retry", async () => {
    const readSource = vi.fn()
      .mockRejectedValueOnce(new Error("service busy"))
      .mockResolvedValue(undefined);
    const readProject = vi.fn(async () => {});
    const refresh = new ProfileProjectionRefresh(readSource, readProject);

    await expect(refresh.request("local")).rejects.toThrow("service busy");
    expect(readProject).not.toHaveBeenCalled();
    await refresh.request("local");
    expect(readSource).toHaveBeenCalledTimes(2);
    expect(readProject).toHaveBeenCalledOnce();
  });
});
