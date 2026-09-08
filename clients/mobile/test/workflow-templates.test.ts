import { describe, expect, it, vi } from "vitest";
import { createMockWorkflowTemplates } from "../src/adapters/mock/workflow-templates";
import { createWorkflowTemplatesPort } from "../src/adapters/production/workflow-templates";
import { MobileControlError, type MobileControlClient } from "../src/adapters/production/mobile-control-client";
import { WorkflowMutationUnconfirmedError } from "../src/application/workflow-templates-port";
import { deleteWorkflowTemplate, saveWorkflowTemplate } from "../src/application/workflow-template-commands";
import { addWorkflowStep, canMoveWorkflowStep, moveWorkflowStep, normalizedWorkflowDraft, removeWorkflowStep, sanitizeWorkflowReuse, startingWorkflowSteps, workflowDraft, workflowDraftError, workflowSummary } from "../src/presentation/workflow-template";

const draft = () => ({ ...workflowDraft(), name: "Feature review", steps: startingWorkflowSteps("discussed") });
const target = { connectionId: "mac-a", projectId: "project-a" };

describe("mobile workflow drafts", () => {
  it("starts unnamed, offers three genuinely new starts, and clones saved steps", async () => {
    expect(workflowDraft()).toMatchObject({ name: "", steps: [] });
    expect(startingWorkflowSteps("simple").map((step) => step.kind)).toEqual(["implement"]);
    expect(startingWorkflowSteps("reviewed").map((step) => step.kind)).toEqual(["implement", "review", "fix"]);
    const steps = startingWorkflowSteps("discussed");
    expect(steps.map((step) => step.kind)).toEqual(["discuss", "implement", "review", "review", "fix"]);
    expect(steps[2]).toMatchObject({ reuseStepId: steps[0]!.id, model: null, permission: null, reasoning: null });
    expect(workflowSummary(steps)).toContain("2 reviewers in parallel");
    const port = createMockWorkflowTemplates();
    const result = await port.create(target.connectionId, { ...draft(), projectId: target.projectId, expectedRevision: 1 });
    const copy = workflowDraft(result.configuration);
    copy.steps[0]!.title = "Changed locally";
    expect(result.configuration.steps[0]!.title).toBe("Challenge the approach");
  });

  it("keeps the required implementation, bounds steps, and preserves phase ordering", () => {
    let steps = startingWorkflowSteps("simple");
    expect(removeWorkflowStep(steps, steps[0]!.id)).toEqual(steps);
    expect(addWorkflowStep(steps, "fix")).toEqual(steps);
    steps = addWorkflowStep(steps, "review");
    steps = addWorkflowStep(steps, "fix");
    expect(addWorkflowStep(steps, "fix")).toEqual(steps);
    for (let index = 0; index < 10; index++) steps = addWorkflowStep(steps, "discuss");
    expect(steps).toHaveLength(8);
    expect(new Set(steps.map((step) => step.id)).size).toBe(8);
    expect(steps.map((step) => step.kind)).toEqual(["discuss", "discuss", "discuss", "discuss", "discuss", "implement", "review", "fix"]);
    expect(canMoveWorkflowStep(steps, steps[4]!.id, 1)).toBe(false);
    expect(moveWorkflowStep(steps, steps[0]!.id, 1)[1]!.id).toBe(steps[0]!.id);
    expect(removeWorkflowStep(steps, steps[6]!.id).map((step) => step.kind)).not.toContain("fix");
  });

  it("repairs reused conversations when a discussion is removed or its provider changes", () => {
    const steps = startingWorkflowSteps("discussed");
    expect(removeWorkflowStep(steps, steps[0]!.id)[1]).toMatchObject({ reuseStepId: null, model: "default", permission: "bypassPermissions" });
    expect(sanitizeWorkflowReuse(steps.map((step, index) => index === 0 ? { ...step, agentId: "codex" } : step))[2]!.reuseStepId).toBeNull();
    expect(moveWorkflowStep(steps, steps[2]!.id, 1)[3]!.reuseStepId).toBe(steps[0]!.id);
  });

  it("requires meaningful names and instructions, trimming only at save", () => {
    expect(workflowDraftError(workflowDraft())?.message).toContain("name");
    const value = draft(); value.steps[1]!.instructions = "  ";
    expect(workflowDraftError(value)).toMatchObject({ stepId: value.steps[1]!.id });
    value.name = "  My workflow  ";
    expect(normalizedWorkflowDraft(value).name).toBe("My workflow");
    expect(value.name).toBe("  My workflow  ");
  });
});

describe("mobile workflow commands", () => {
  it("distinguishes a definitive rejection from an unconfirmed mutation", async () => {
    const call = vi.fn().mockRejectedValue(new Error("connection failed"));
    const port = createWorkflowTemplatesPort(async () => ({ call }));
    await expect(port.create("mac-a", { ...draft(), projectId: "project-a", expectedRevision: 1 })).rejects.toBeInstanceOf(WorkflowMutationUnconfirmedError);
    const rejection = new MobileControlError("state changed", "conflict");
    call.mockRejectedValue(rejection);
    await expect(port.remove("mac-a", { workflowId: "workflow-a", expectedRevision: 1 })).rejects.toBe(rejection);
    for (const code of ["operationFailed", "incompatibleProjection"]) {
      call.mockRejectedValue(new MobileControlError("unconfirmed reply", code));
      await expect(port.remove("mac-a", { workflowId: "workflow-a", expectedRevision: 1 })).rejects.toBeInstanceOf(WorkflowMutationUnconfirmedError);
    }
    expect(call).toHaveBeenCalledTimes(4);
  });
  it("creates, updates, and deletes the same authoritative template using fresh revisions", async () => {
    const port = createMockWorkflowTemplates();
    const publish = vi.fn();
    await saveWorkflowTemplate(port, target, draft(), publish);
    const first = (await port.list(target.connectionId, target.projectId)).configurations[0]!;
    await saveWorkflowTemplate(port, { ...target, existing: { id: first.id, generation: first.generation } }, { ...draft(), name: "Updated" }, publish);
    const updated = (await port.list(target.connectionId, target.projectId)).configurations[0]!;
    expect(updated).toMatchObject({ id: first.id, name: "Updated", generation: 2 });
    await deleteWorkflowTemplate(port, { ...target, existing: { id: updated.id, generation: updated.generation } }, publish);
    expect((await port.list(target.connectionId, target.projectId)).configurations).toEqual([]);
  });

  it("refuses stale drafts, deleted templates, and cross-project targets without mutation", async () => {
    const port = createMockWorkflowTemplates();
    await saveWorkflowTemplate(port, target, draft(), vi.fn());
    const saved = (await port.list(target.connectionId, target.projectId)).configurations[0]!;
    const existing = { id: saved.id, generation: saved.generation };
    await saveWorkflowTemplate(port, { ...target, existing }, { ...draft(), name: "Desktop edit" }, vi.fn());
    const update = vi.spyOn(port, "update"), remove = vi.spyOn(port, "remove"), publish = vi.fn();
    await expect(saveWorkflowTemplate(port, { ...target, existing }, draft(), publish)).rejects.toThrow("changed on your Mac");
    await expect(deleteWorkflowTemplate(port, { ...target, existing }, publish)).rejects.toThrow("changed on your Mac");
    await expect(saveWorkflowTemplate(port, { ...target, projectId: "other", existing }, draft(), publish)).rejects.toThrow("deleted");
    expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
    await deleteWorkflowTemplate(port, { ...target, existing: { ...existing, generation: 2 } }, publish);
    await expect(saveWorkflowTemplate(port, { ...target, existing }, draft(), publish)).rejects.toThrow("deleted");
    expect(update).not.toHaveBeenCalled();
  });

  it("never retries a mutation after an ambiguous failure and never publishes success", async () => {
    const port = createMockWorkflowTemplates();
    const create = vi.spyOn(port, "create").mockRejectedValue(new Error("connection failed"));
    const publish = vi.fn();
    await expect(saveWorkflowTemplate(port, target, draft(), publish)).rejects.toThrow("connection failed");
    expect(create).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0].configurations).toEqual([]);
  });

  it("enforces the project quota and keeps mock connection data isolated", async () => {
    const port = createMockWorkflowTemplates();
    for (let index = 0; index < 16; index++) await saveWorkflowTemplate(port, target, draft(), vi.fn());
    const create = vi.spyOn(port, "create");
    await expect(saveWorkflowTemplate(port, target, draft(), vi.fn())).rejects.toThrow("16 templates");
    expect(create).not.toHaveBeenCalled();
    expect((await port.list("mac-b", target.projectId)).configurations).toEqual([]);
    expect((await createMockWorkflowTemplates().list(target.connectionId, target.projectId)).configurations).toEqual([]);
  });

  it("the production adapter forwards only named commands on the selected connection", async () => {
    const call = vi.fn(async (method: string) => method === "agent.libraryGet" ? { profiles: [], revision: 1 } : method === "agent.capabilityList" ? [] : {});
    const resolve = vi.fn(async (_connectionId: string) => ({ call: call as MobileControlClient["call"] }));
    const port = createWorkflowTemplatesPort(resolve);
    await port.list("mac-a", "project-a");
    await port.catalog("mac-a");
    await port.create("mac-a", { ...draft(), projectId: "project-a", expectedRevision: 7 });
    await port.update("mac-a", { ...draft(), workflowId: "workflow-a", expectedRevision: 8 });
    await port.remove("mac-a", { workflowId: "workflow-a", expectedRevision: 9 });
    expect(resolve.mock.calls.every(([id]) => id === "mac-a")).toBe(true);
    expect(call.mock.calls.map(([method]) => method)).toEqual(["workflow.configurationList", "agent.capabilityList", "agent.libraryGet", "workflow.configurationCreate", "workflow.configurationUpdate", "workflow.configurationDelete"]);
    expect(call).toHaveBeenLastCalledWith("workflow.configurationDelete", { workflowId: "workflow-a", expectedRevision: 9 });
  });
});
