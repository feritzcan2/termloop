import type { ProjectDto, TaskDto } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import { fixtureProjects, fixtureTasks } from "../../src/fixtures/mobile-overview";
import { shareLaunchTarget, shareMacs, sharedImageReadyToSend, shareTargets } from "../../src/presentation/share-target";

const project = fixtureProjects[0]!;
const ready = fixtureTasks.find((task) => task.worktree_health?.launch_ready === true && task.status === "open" && task.worktree !== null)!;

describe("share targets", () => {
  it("offers every project with only its launch-ready open tasks", () => {
    const other: ProjectDto = { ...project, id: "other", name: "Aardvark" };
    const tasks: TaskDto[] = [
      { ...ready, id: "b", title: "Beta", project_id: project.id },
      { ...ready, id: "a", title: "Alpha", project_id: project.id },
      { ...ready, id: "closed", status: "closed", project_id: project.id },
      { ...ready, id: "archived", archived_at_epoch_ms: 1, project_id: project.id },
      { ...ready, id: "no-worktree", worktree: null, project_id: project.id },
      { ...ready, id: "elsewhere", project_id: "other" },
    ];
    const targets = shareTargets([{ ...project, name: "Zulu" }, other], tasks);
    expect(targets.map((target) => target.project.id)).toEqual(["other", project.id]);
    expect(targets.find((target) => target.project.id === project.id)?.tasks.map((task) => task.id)).toEqual(["a", "b"]);
    expect(targets.find((target) => target.project.id === "other")?.tasks.map((task) => task.id)).toEqual(["elsewhere"]);
  });

  it("encodes the launch route target the way the launch screen reads it", () => {
    expect(shareLaunchTarget({ projectId: "p1" })).toBe("project:p1");
    expect(shareLaunchTarget({ projectId: "p1", taskId: "t1" })).toBe("t1");
  });

  it("auto-sends only once the agent waits at its prompt", () => {
    expect(sharedImageReadyToSend(true, "idle")).toBe(true);
    expect(sharedImageReadyToSend(true, "awaitingInput")).toBe(true);
    for (const status of ["unknown", "working", "compacting", "failed", "exited", undefined]) {
      expect(sharedImageReadyToSend(true, status)).toBe(false);
    }
    expect(sharedImageReadyToSend(false, "idle")).toBe(false);
  });
});

describe("share Macs", () => {
  it("lists every reachable Mac's projects ahead of unreachable ones, not just the selected Mac", () => {
    const overview = { projects: [project], tasks: [] };
    const macs = shareMacs([
      { id: "offline", name: "Old Mac", availability: "offline" },
      { id: "loading", name: "Studio", availability: "online" },
      { id: "reconnecting", name: "Air", availability: "reconnecting" },
      { id: "ready", name: "MacBook", availability: "online" },
      { id: "failed", name: "Mini", availability: "online" },
    ], new Map([
      ["offline", { load: "ready", overview }],
      ["loading", { load: "loading", overview: undefined }],
      ["reconnecting", { load: "loading", overview: undefined }],
      ["ready", { load: "ready", overview }],
      ["failed", { load: "failed", overview: undefined }],
    ]));
    expect(macs.map((mac) => [mac.connectionId, mac.state])).toEqual([
      ["ready", "ready"], ["loading", "loading"], ["offline", "unavailable"], ["reconnecting", "unavailable"], ["failed", "unavailable"],
    ]);
    expect(macs[0]!.targets.map((target) => target.project.id)).toEqual([project.id]);
    expect(macs.slice(1).every((mac) => mac.targets.length === 0)).toBe(true);
  });
});
