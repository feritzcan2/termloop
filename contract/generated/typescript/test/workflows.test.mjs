import assert from "node:assert/strict";
import test from "node:test";
import { validateMethodResult } from "../dist/current.js";

test("workflow completion and pending reviewers are bounded generated projections", () => {
  const execution = {
    id: "execution-1", projectId: "project-1", taskId: "task-1", workflowId: "workflow-1",
    workflowGeneration: 1, workflowName: "Build", goal: "Implement the feature",
    coordinatorSessionId: "coordinator-1", currentStepIndex: 1, reviewCycle: 1, maxReviewCycles: 2,
    phase: "completed", status: "completed", completionOutcome: "completed",
    steps: [{ id: "implement", kind: "implement", title: "Implement", instructions: "Build it",
      agentId: null, reuseStepId: null, profileRef: null, model: null, permission: null, reasoning: null }],
    participants: [], activeReviewStepIds: [], pendingReviewStepIds: [], stepResults: [],
    startedAtEpochMs: 1, updatedAtEpochMs: 1,
  };
  const valid = (value) => validateMethodResult("workflow.configurationList", {
    configurations: [], executions: [value], stateRevision: 1,
  });
  for (const completionOutcome of [null, "completed", "approved", "changesRequested", "reviewLimitReached"]) {
    assert.ok(valid({ ...execution, completionOutcome }));
  }
  assert.ok(!valid({ ...execution, completionOutcome: "success" }));
  assert.ok(valid({ ...execution, pendingReviewStepIds: ["review-1", "review-2"] }));
  assert.ok(!valid({ ...execution, pendingReviewStepIds: ["review-1", "review-1"] }));
  assert.ok(!valid({ ...execution, pendingReviewStepIds: Array.from({ length: 9 }, (_, index) => `review-${index}`) }));
  const { completionOutcome, ...missingOutcome } = execution;
  assert.ok(!valid(missingOutcome));
});
