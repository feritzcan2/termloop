import { describe, expect, it } from "vitest";
import { sessionParentRoute } from "../src/features/connection/connection-route";
import { backNavigationAction } from "../src/presentation/back-navigation";

describe("workflow agent navigation", () => {
  it("returns helper conversations to their originating Task on the same Mac", () => {
    const parent = sessionParentRoute("mac-away", "project-a", "task-workflow");
    expect(parent).toEqual({ label: "Workflow", href: { pathname: "/task/[taskId]", params: { connectionId: "mac-away", taskId: "task-workflow" } } });
    expect(backNavigationAction(true, parent.href !== undefined)).toBe("replace");
  });

  it("retains a safe workflow destination when restored by OTA before the Session loads", () => {
    const parent = sessionParentRoute("mac-away", undefined, "task-workflow");
    expect(parent.href?.params).toEqual({ connectionId: "mac-away", taskId: "task-workflow" });
    expect(backNavigationAction(false, parent.href !== undefined)).toBe("replace");
  });

  it("preserves normal Session navigation without workflow context", () => {
    expect(sessionParentRoute("mac-away", "project-a")).toEqual({ label: "Project", href: { pathname: "/project/[projectId]", params: { connectionId: "mac-away", projectId: "project-a" } } });
    expect(sessionParentRoute(undefined, undefined)).toEqual({ label: "Project", href: undefined });
  });
});
