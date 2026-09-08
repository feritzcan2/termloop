import type { TaskDto } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import type { MobileOverview } from "../../src/application/ports";
import { fixtureAgentStatuses, fixtureProjects, fixtureSessions, fixtureTasks } from "../../src/fixtures/mobile-overview";
import { buildProjectOverview } from "../../src/presentation/attention-overview";
import { buildTaskBrowserItems, filterTaskItems, taskAttachedAgents, taskFilters } from "../../src/presentation/task-browser";
import { taskAtAGlance, taskStage } from "../../src/presentation/task-presentation";

const base = fixtureTasks[0]!;
const unattached = { ...base };
delete unattached.worktree_presence;
function itemsFor(tasks: TaskDto[], sessions = fixtureSessions, agentStatuses = fixtureAgentStatuses) {
  const overview: MobileOverview = { projects: fixtureProjects, tasks, sessions, agentStatuses, stewardEnabledProjectIds: [], stewardExecutorSessionIds: {}, agentGroupsByProject: {} };
  const model = buildProjectOverview(overview, base.project_id);
  return { items: buildTaskBrowserItems(model.tasks, tasks, model.agents), model };
}

describe("task browsing", () => {
  it("keeps setup, working, attention and ready distinct without labeling an unprepared task Ready", () => {
    const tasks: TaskDto[] = [
      base,
      { ...unattached, id: "ready" },
      { ...unattached, id: "planning", worktree: null, branch: null },
      { ...unattached, id: "creating", worktree_provisioning: { status: "running", operation_id: "operation", failure: null } },
      { ...unattached, id: "repair", worktree_health: { ...base.worktree_health!, launch_ready: false, path_state: "absent" } },
      { ...base, id: "closed", status: "closed" },
      { ...base, id: "other-project", project_id: "elsewhere" },
    ];
    const { items } = itemsFor(tasks);
    expect(items.find((item) => item.task.id === "planning")).toMatchObject({ filter: "setup", status: "Setup needed" });
    expect(items.find((item) => item.task.id === "ready")).toMatchObject({ filter: "ready", status: "Ready to start" });
    expect(items.find((item) => item.task.id === "creating")).toMatchObject({ filter: "active", status: "Preparing workspace" });
    expect(items.find((item) => item.task.id === "repair")?.filter).toBe("attention");
    expect(items.find((item) => item.task.id === base.id)?.filter).toBe("attention");
    expect(items.map((item) => item.task.id)).not.toContain("closed");
    expect(items.map((item) => item.task.id)).not.toContain("other-project");
    expect(taskFilters.slice(1).flatMap((filter) => filterTaskItems(items, filter.id, ""))).toHaveLength(items.length);
  });

  it("searches title, goal, branch and issue together and preserves the urgency order", () => {
    const { items } = itemsFor([
      { ...base, jira_url: "https://example.atlassian.net/browse/KAN-321" },
      { ...unattached, id: "quiet", title: "Mobile offline recovery", brief: "Keep an edited goal", branch: { ...base.branch!, name: "fix/reconnect" } },
    ]);
    expect(filterTaskItems(items, "all", " MOBILE ").map((item) => item.task.id)).toEqual([base.id, "quiet"]);
    expect(filterTaskItems(items, "all", "KAN-321 foundation").map((item) => item.task.id)).toEqual([base.id]);
    expect(filterTaskItems(items, "all", "RECONNECT edited").map((item) => item.task.id)).toEqual(["quiet"]);
    expect(filterTaskItems(items, "attention", "reconnect")).toEqual([]);
    expect(filterTaskItems(items, "all", "   ")).toEqual(items);
    expect(filterTaskItems(items, "all", "nothing matches")).toEqual([]);
  });

  it("offers only a live attached agent and preserves the exact task for reviewing changes", () => {
    const { items } = itemsFor([base]);
    expect(items[0]).toMatchObject({ agent: { sessionId: fixtureSessions[0]!.id }, changeCount: 4, task: { id: base.id } });
    const stopped = { ...fixtureSessions[0]!, lifecycle_state: "exited" as const };
    expect(itemsFor([base], [stopped]).items[0]?.agent).toBeUndefined();
    expect(itemsFor([unattached]).items[0]?.agent).toBeUndefined();
  });

  it("does not call an idle or stopped agent working", () => {
    const { items, model } = itemsFor([base], fixtureSessions, [{ ...fixtureAgentStatuses[0]!, status: "idle" }]);
    const agents = taskAttachedAgents(base, model.agents);
    expect(items[0]).toMatchObject({ filter: "ready", status: "Agent available" });
    expect(taskAtAGlance(taskStage(base), agents)).toMatchObject({ title: "1 agent available", tone: "quiet" });
    expect(taskAtAGlance(taskStage(base), [{ ...agents[0]!, attachable: false }])).toMatchObject({ title: "Ready to start", tone: "quiet" });
    expect(taskAtAGlance(taskStage(base), [{ ...agents[0]!, tone: "working" }])).toMatchObject({ title: "1 agent working", tone: "working" });
  });
});
