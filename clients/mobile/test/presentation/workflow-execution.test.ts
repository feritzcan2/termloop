import { describe, expect, it } from "vitest";
import { fixtureWorkflowProgress } from "../../src/fixtures/workflow-progress";
import { taskWorkflowExecution, workflowExecutionView } from "../../src/presentation/workflow-execution";

describe("workflow execution presentation", () => {
  it("uses active-first, newest-first Task scoping without mutating the projection", () => {
    const { execution } = fixtureWorkflowProgress();
    const completed = { ...execution, id: "newer-completed", status: "completed" as const, startedAtEpochMs: execution.startedAtEpochMs + 1 };
    const items = [completed, { ...execution, taskId: "other", id: "other" }, execution];
    expect(taskWorkflowExecution(items, execution.taskId!)).toBe(execution);
    expect(items[0]).toBe(completed);
    expect(taskWorkflowExecution([completed, { ...completed, startedAtEpochMs: 0 }], execution.taskId!)).toBe(completed);
    expect(taskWorkflowExecution(items, "missing")).toBeUndefined();
  });

  it("shows parallel reviewers independently and never counts a prior-round result as current approval", () => {
    const { execution, sessions, statuses } = fixtureWorkflowProgress();
    const view = workflowExecutionView(execution, sessions, statuses);
    expect(view.headline).toBe("Parallel review");
    expect(view.detail).toContain("1 of 2 replies received");
    expect(view.progress).toBe("1/2 reviews recorded");
    expect(view.rows.map((row) => row.state)).toEqual(["complete", "complete", "current", "complete", "upcoming"]);
    expect(view.rows[2]).toMatchObject({ previousRound: true, label: "In progress", agent: { id: "workflow-context", status: "Working" } });
    expect(view.rows[2]!.owner).toContain("continues");
    expect(view.rows[4]).toMatchObject({ previousRound: true, label: "If needed" });
    expect(view.attentionAgents).toEqual([]);
  });

  it("a delivered helper reply and an idle agent are not completed outcomes", () => {
    const { execution, sessions, statuses } = fixtureWorkflowProgress();
    execution.stepResults = execution.stepResults.filter((result) => result.stepId !== execution.steps[3]!.id);
    const view = workflowExecutionView(execution, sessions, statuses);
    expect(view.rows[3]).toMatchObject({ state: "recording", label: "Reply received", agent: { status: "Idle" } });
    expect(view.done).toBe(2);
    execution.phase = "awaitingStepCompletion";
    execution.pendingReviewStepIds = [];
    expect(workflowExecutionView(execution, sessions, statuses).rows[2]!.state).toBe("recording");
  });

  it("tracks each review round and active fix without reusing previous progress", () => {
    const { execution, sessions, statuses } = fixtureWorkflowProgress();
    execution.currentStepIndex = 4;
    execution.phase = "awaitingCoordinator";
    const view = workflowExecutionView(execution, sessions, statuses);
    expect(view.rows[4]).toMatchObject({ state: "current", previousRound: true });
    expect(view.rows[4]!.agent?.id).toBe(execution.coordinatorSessionId);
    expect(view.detail).toContain("applying");
    // Missing current-round evidence is not painted green, even behind the cursor.
    expect(view.rows[2]!.state).toBe("unrecorded");
  });

  it.each([
    ["approved", "Approved", "All reviewers approved", "done"],
    ["completed", "Completed", "No final review approval", "done"],
    ["changesRequested", "Changes requested", "no automatic fix", "attention"],
    ["reviewLimitReached", "Review limit reached", "not been reviewed again", "attention"],
  ] as const)("keeps the %s completion outcome explicit", (outcome, label, detail, tone) => {
    const { execution, sessions, statuses } = fixtureWorkflowProgress();
    execution.status = "completed"; execution.phase = "completed"; execution.currentStepIndex = execution.steps.length; execution.completionOutcome = outcome;
    const view = workflowExecutionView(execution, sessions, statuses);
    expect(view).toMatchObject({ label, tone, completed: true, attentionAgents: [] });
    expect(view.detail).toContain(detail);
    expect(view.rows[2]!.state).toBe("unrecorded");
    expect(view.done).toBeLessThan(view.rows.length);
  });

  it("marks an explicitly skipped fix separately from a completed fix", () => {
    const { execution, sessions, statuses } = fixtureWorkflowProgress();
    execution.status = "completed"; execution.currentStepIndex = execution.steps.length;
    execution.stepResults[4] = { ...execution.stepResults[4]!, reviewCycle: 2, outcome: "skipped" };
    expect(workflowExecutionView(execution, sessions, statuses).rows[4]).toMatchObject({ state: "skipped", label: "Skipped" });
  });

  it("uses lifecycle before stale working status and only surfaces relevant agents needing attention", () => {
    const { execution, sessions, statuses } = fixtureWorkflowProgress();
    sessions[0] = { ...sessions[0]!, lifecycle_state: "exited" };
    statuses[0] = { ...statuses[0]!, status: "working" };
    statuses[1] = { ...statuses[1]!, status: "awaitingInput" };
    statuses[2] = { ...statuses[2]!, status: "awaitingInput" }; // already completed reviewer
    execution.status = "paused";
    const view = workflowExecutionView(execution, sessions, statuses);
    expect(view).toMatchObject({ label: "Paused", lead: { status: "Exited" } });
    expect(view.attentionAgents.map((agent) => agent.id)).toEqual([sessions[0]!.id, sessions[1]!.id]);
  });

  it("retains results without a saved template or available sessions; never invents agents", () => {
    const { execution } = fixtureWorkflowProgress();
    const view = workflowExecutionView(execution, [], []);
    expect(view.lead).toMatchObject({ available: false, status: "Session unavailable" });
    expect(view.rows[2]!.result?.summary).toContain("Two findings");
    execution.participants = execution.participants.filter((participant) => participant.stepId !== execution.steps[2]!.id);
    expect(workflowExecutionView(execution, [], []).rows[2]!.agent?.id).toBe("workflow-context");
    execution.participants = [];
    expect(workflowExecutionView(execution, [], []).rows[2]!.agent).toBeUndefined();
  });
});
