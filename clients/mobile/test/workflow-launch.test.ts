import type { WorkflowConfigurationDto, WorkflowConfigurationListResult } from "@termloop/contract/current";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowLaunchPort } from "../src/adapters/production/workflow-launch";
import { MobileControlError, type MobileControlClient } from "../src/adapters/production/mobile-control-client";
import { WorkflowLaunchUnconfirmedError } from "../src/application/workflow-launch-port";
import { fixtureSessions } from "../src/fixtures/mobile-overview";
import { startingWorkflowSteps, workflowDraft } from "../src/presentation/workflow-template";

const launchConfiguration = (): WorkflowConfigurationDto => ({ ...workflowDraft(), name: "Build & review", steps: startingWorkflowSteps("reviewed"), id: "workflow-a", projectId: "project-a", generation: 1, updatedAtEpochMs: 1 });
const params = { taskId: "task-a", workflowId: "workflow-a", goal: "  Task description\nwith details  " };

function harness(snapshot: WorkflowConfigurationListResult = { configurations: [launchConfiguration()], executions: [], stateRevision: 1 }, failure?: Error, previewFailure?: Error) {
  const call = vi.fn(async (method: string, _params: unknown) => {
    if (method === "workflow.configurationList") return snapshot;
    if (method === "task.previewWorkflow") {
      if (previewFailure) throw previewFailure;
      return { launch_ticket: "exact-ticket" };
    }
    if (failure) throw failure;
    return fixtureSessions[0]!;
  });
  const resolve = vi.fn(async (_connection: string) => ({ call: call as MobileControlClient["call"] }));
  return { call, resolve, port: createWorkflowLaunchPort(resolve) };
}

describe("mobile workflow launch", () => {
  it("revalidates the selected generation and spends the exact preview ticket only once", async () => {
    const h = harness();
    expect(await h.port.start("mac-a", params, launchConfiguration())).toEqual(fixtureSessions[0]);
    expect(h.resolve).toHaveBeenCalledWith("mac-a");
    expect(h.call.mock.calls).toEqual([
      ["workflow.configurationList", { projectId: "project-a" }],
      ["task.previewWorkflow", { ...params, goal: params.goal.trim() }],
      ["task.launchWorkflow", { ...params, goal: params.goal.trim(), launchTicket: "exact-ticket" }],
    ]);
  });

  it.each([{ configurations: [] }, { configurations: [{ ...launchConfiguration(), generation: 2 }] }, { configurations: [{ ...launchConfiguration(), projectId: "other" }] }])("refuses deleted, changed, or cross-project templates before preview", async ({ configurations }) => {
    const h = harness({ configurations, executions: [], stateRevision: 2 });
    await expect(h.port.start("mac-a", params, launchConfiguration())).rejects.toThrow("template changed");
    expect(h.call).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "paused"] as const)("refuses a second workflow when one is %s", async (status) => {
    const snapshot = { configurations: [launchConfiguration()], executions: [{ taskId: params.taskId, status }], stateRevision: 2 } as WorkflowConfigurationListResult;
    const h = harness(snapshot);
    await expect(h.port.start("mac-a", params, launchConfiguration())).rejects.toThrow("already has an active");
    expect(h.call).toHaveBeenCalledTimes(1);
  });

  it("does not send a launch after preview failure", async () => {
    const h = harness(undefined, undefined, new Error("preview unavailable"));
    await expect(h.port.start("mac-a", params, launchConfiguration())).rejects.toThrow("preview unavailable");
    expect(h.call).toHaveBeenCalledTimes(2);
  });

  it.each([new Error("socket closed"), new MobileControlError("bad reply", "incompatibleProjection"), new MobileControlError("launch failed", "operationFailed")])("keeps ambiguous launch outcomes non-retryable", async (failure) => {
    const h = harness(undefined, failure);
    await expect(h.port.start("mac-a", params, launchConfiguration())).rejects.toBeInstanceOf(WorkflowLaunchUnconfirmedError);
    expect(h.call).toHaveBeenCalledTimes(3);
  });

  it("preserves a definitive daemon rejection and rejects empty or oversized goals locally", async () => {
    const rejection = new MobileControlError("ticket expired", "conflict");
    const h = harness(undefined, rejection);
    await expect(h.port.start("mac-a", params, launchConfiguration())).rejects.toBe(rejection);
    h.call.mockClear();
    for (const goal of ["  ", "a".repeat(32_769)]) await expect(h.port.start("mac-a", { ...params, goal }, launchConfiguration())).rejects.toThrow("Enter a workflow goal");
    expect(h.call).not.toHaveBeenCalled();
  });
});
