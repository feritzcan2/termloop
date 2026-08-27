import type {
  PlaybookDto,
  PlaybookMilestoneDto,
  PlaybookRuntimeResult,
  PlaybookRuntimeStepDto,
  PlaybookStepProgressDto,
} from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import {
  pipelineProgressLabel,
  pipelineSegments,
  stepAnswerSource,
  stepEvidence,
  stepIsCheckable,
  stepPositionAction,
  stepRowSummary,
  stepTiming,
  taskPipelineView,
  terminusPositionAction,
} from "../../src/presentation/playbook-presentation";

const NOW = 1_700_000_000_000;

function milestone(overrides: Partial<PlaybookMilestoneDto> = {}): PlaybookMilestoneDto {
  return {
    id: "code-done",
    title: "Did the agent finish the code?",
    gate: "automatic",
    routineId: "routine-code",
    retryDelaySeconds: 600,
    condition: "The Task branch has commits.",
    approver: null,
    ...overrides,
  };
}

function playbook(milestones: PlaybookMilestoneDto[]): PlaybookDto {
  return {
    projectId: "project-1",
    revision: 3,
    activePipelineName: "Dev PR to production",
    milestones,
    savedPipelines: [],
    updatedAtEpochMs: NOW,
  };
}

function progress(overrides: Partial<PlaybookStepProgressDto> = {}): PlaybookStepProgressDto {
  return {
    taskId: "task-1",
    verdict: "passed",
    evidence: "Branch has 3 commits and no agent is working.",
    decidedAtEpochMs: NOW - 3_600_000,
    nextAttemptAtEpochMs: null,
    ...overrides,
  };
}

function step(overrides: Partial<PlaybookRuntimeStepDto> = {}): PlaybookRuntimeStepDto {
  return {
    milestoneId: "code-done",
    routineId: "routine-code",
    waitingTaskIds: [],
    progress: [],
    nextAttemptAtEpochMs: null,
    ...overrides,
  };
}

function runtime(steps: PlaybookRuntimeStepDto[], doneTaskIds: string[] = []): PlaybookRuntimeResult {
  return { activePipelineName: "Dev PR to production", processingTaskId: null, steps, doneTaskIds, stateRevision: 9 };
}

const THREE = [
  milestone(),
  milestone({ id: "review", title: "Was a review requested?", routineId: "routine-review" }),
  milestone({ id: "deployed", title: "Did it deploy?", routineId: "routine-deploy" }),
];

const ROUTINES = [
  { id: "routine-code", name: "Code check", enabled: true },
  { id: "routine-review", name: "Review watcher", enabled: true },
  { id: "routine-deploy", name: "Deploy watcher", enabled: false },
];

describe("a Task's place on the pipeline", () => {
  it("clears every step behind the one core says the Task waits at", () => {
    const view = taskPipelineView(
      playbook(THREE),
      runtime([
        step({ progress: [progress()] }),
        step({ milestoneId: "review", routineId: "routine-review", waitingTaskIds: ["task-1"] }),
        step({ milestoneId: "deployed", routineId: "routine-deploy" }),
      ]),
      ROUTINES,
      "task-1",
    );

    expect(view?.placement).toBe("waiting");
    expect(view?.standingAt).toBe(2);
    expect(view?.steps.map((entry) => entry.standing)).toEqual(["passed", "waiting", "ahead"]);
    expect(pipelineProgressLabel(view!)).toBe("Step 2 of 3");
  });

  it("keeps each Task's own answers apart when several wait at one step", () => {
    const view = taskPipelineView(
      playbook(THREE),
      runtime([
        step({
          waitingTaskIds: ["task-1", "task-2"],
          progress: [
            progress({ taskId: "task-2", evidence: "Another Task's answer." }),
            progress({ taskId: "task-1", verdict: "waiting", evidence: "This Task's answer." }),
          ],
        }),
      ]),
      ROUTINES,
      "task-1",
    );

    expect(view?.steps[0]?.progress?.evidence).toBe("This Task's answer.");
  });

  it("leaves a Task the pipeline no longer walks with only its recorded answers", () => {
    const view = taskPipelineView(
      playbook(THREE),
      runtime([
        step({ progress: [progress()] }),
        step({ milestoneId: "review", routineId: "routine-review" }),
        step({ milestoneId: "deployed", routineId: "routine-deploy" }),
      ]),
      ROUTINES,
      "task-1",
    );

    expect(view?.placement).toBe("away");
    expect(view?.standingAt).toBeUndefined();
    expect(view?.steps.map((entry) => entry.standing)).toEqual(["passed", "ahead", "ahead"]);
    expect(pipelineProgressLabel(view!)).toBe("1 of 3 cleared");
  });

  it("marks a Task core lists as done as having cleared every step", () => {
    const view = taskPipelineView(
      playbook(THREE),
      runtime(THREE.map((entry) => step({ milestoneId: entry.id, progress: [progress()] })), ["task-1"]),
      ROUTINES,
      "task-1",
    );

    expect(view?.placement).toBe("done");
    expect(pipelineProgressLabel(view!)).toBe("Cleared all 3");
  });

  it("draws no ladder when the Project is not walking a pipeline", () => {
    expect(taskPipelineView(null, null, ROUTINES, "task-1")).toBeUndefined();
    expect(taskPipelineView(playbook([]), null, ROUTINES, "task-1")).toBeUndefined();
  });
});

describe("what a step tells a phone", () => {
  const view = taskPipelineView(
    playbook(THREE),
    runtime([
      step({ progress: [progress()] }),
      step({
        milestoneId: "review",
        routineId: "routine-review",
        waitingTaskIds: ["task-1"],
        progress: [progress({
          verdict: "waiting",
          evidence: "No review request seen yet.",
          decidedAtEpochMs: NOW - 600_000,
          nextAttemptAtEpochMs: NOW + 720_000,
        })],
      }),
      step({ milestoneId: "deployed", routineId: "routine-deploy" }),
    ]),
    ROUTINES,
    "task-1",
  )!;

  it("looks back on a cleared step and forward on the standing one", () => {
    expect(stepTiming(view.steps[0]!, NOW)).toBe("cleared 1h ago");
    expect(stepTiming(view.steps[1]!, NOW)).toBe("next check in 12m");
    expect(stepTiming(view.steps[2]!, NOW)).toBeUndefined();
  });

  it("says a check is imminent rather than counting past zero", () => {
    expect(stepTiming(view.steps[1]!, NOW + 900_000)).toBe("checking next");
  });

  it("names who answers a step, and warns when nobody can", () => {
    expect(stepAnswerSource(view.steps[1]!)).toEqual({ text: "Review watcher", blocked: false });
    expect(stepAnswerSource(view.steps[2]!)).toEqual({ text: "Deploy watcher is off", blocked: true });
  });

  it("names the approver on a human gate and refuses an unnamed one", () => {
    const human = taskPipelineView(
      playbook([milestone({ gate: "human", routineId: "", approver: "Nurguyl" })]),
      runtime([step({ routineId: "", waitingTaskIds: ["task-1"] })]),
      ROUTINES,
      "task-1",
    )!;
    expect(stepAnswerSource(human.steps[0]!)).toEqual({ text: "Nurguyl approves this", blocked: false });

    const unnamed = taskPipelineView(
      playbook([milestone({ gate: "human", routineId: "", approver: null })]),
      runtime([step({ routineId: "", waitingTaskIds: ["task-1"] })]),
      ROUTINES,
      "task-1",
    )!;
    expect(stepAnswerSource(unnamed.steps[0]!)).toEqual({ text: "No approver named", blocked: true });
  });

  it("offers a manual check only where one would actually run", () => {
    expect(stepIsCheckable(view.steps[0]!)).toBe(false);
    expect(stepIsCheckable(view.steps[1]!)).toBe(true);
    expect(stepIsCheckable(view.steps[2]!)).toBe(false);
  });

  it("says a standing step has no recorded answer rather than showing nothing", () => {
    const fresh = taskPipelineView(
      playbook(THREE),
      runtime([step({ waitingTaskIds: ["task-1"] })]),
      ROUTINES,
      "task-1",
    )!;
    expect(stepEvidence(fresh.steps[0]!)).toBe("No completion result recorded for this Task yet.");
    expect(stepEvidence(fresh.steps[2]!)).toBeUndefined();
  });
});

describe("the collapsed rail", () => {
  const view = taskPipelineView(
    playbook(THREE),
    runtime([
      step({ progress: [progress({ decidedAtEpochMs: NOW - 720_000 })] }),
      step({
        milestoneId: "review",
        routineId: "routine-review",
        waitingTaskIds: ["task-1"],
        progress: [progress({ verdict: "waiting", nextAttemptAtEpochMs: NOW + 480_000 })],
      }),
      step({ milestoneId: "deployed", routineId: "routine-deploy" }),
    ]),
    ROUTINES,
    "task-1",
  )!;

  it("states position as one countable segment per step", () => {
    expect(pipelineSegments(view)).toEqual(["passed", "waiting", "ahead"]);
    const done = taskPipelineView(
      playbook(THREE),
      runtime(THREE.map((entry) => step({ milestoneId: entry.id })), ["task-1"]),
      ROUTINES,
      "task-1",
    )!;
    expect(pipelineSegments(done)).toEqual(["passed", "passed", "passed"]);
  });

  it("gives each collapsed row one glanceable fact", () => {
    expect(stepRowSummary(view.steps[0]!, NOW)).toBe("12m ago");
    expect(stepRowSummary(view.steps[1]!, NOW)).toBe("in 8m");
    expect(stepRowSummary(view.steps[1]!, NOW + 600_000)).toBe("checking");
    expect(stepRowSummary(view.steps[2]!, NOW)).toBeUndefined();
  });

  it("outranks any countdown with a stalled answer source", () => {
    const stalled = taskPipelineView(
      playbook([milestone({ id: "deployed", title: "Did it deploy?", routineId: "routine-deploy" })]),
      runtime([step({ milestoneId: "deployed", routineId: "routine-deploy", waitingTaskIds: ["task-1"] })]),
      ROUTINES,
      "task-1",
    )!;
    expect(stepRowSummary(stalled.steps[0]!, NOW)).toBe("stalled");
  });

  it("flags an approval ahead, because a person will have to act", () => {
    const human = taskPipelineView(
      playbook([milestone(), milestone({ id: "sign-off", gate: "human", routineId: "", approver: "Nurguyl" })]),
      runtime([step({ waitingTaskIds: ["task-1"] }), step({ milestoneId: "sign-off", routineId: "" })]),
      ROUTINES,
      "task-1",
    )!;
    expect(stepRowSummary(human.steps[1]!, NOW)).toBe("approval");
    expect(stepRowSummary({ ...human.steps[1]!, standing: "waiting" }, NOW)).toBe("approval");
  });
});

describe("correcting the Task's position", () => {
  const view = taskPipelineView(
    playbook(THREE),
    runtime([
      step({ progress: [progress()] }),
      step({ milestoneId: "review", routineId: "routine-review", waitingTaskIds: ["task-1"] }),
      step({ milestoneId: "deployed", routineId: "routine-deploy" }),
    ]),
    ROUTINES,
    "task-1",
  )!;

  it("states the outcome of a move in pipeline terms", () => {
    expect(stepPositionAction(view.steps[0]!, view.placement))
      .toEqual({ label: "Move back here", passedMilestoneCount: 0 });
    expect(stepPositionAction(view.steps[1]!, view.placement))
      .toEqual({ label: "Re-ask this step", passedMilestoneCount: 1 });
    expect(stepPositionAction(view.steps[2]!, view.placement))
      .toEqual({ label: "Skip ahead to here", passedMilestoneCount: 2 });
  });

  it("offers no repositioning for a Task that left the pipeline", () => {
    expect(stepPositionAction(view.steps[0]!, "away")).toBeUndefined();
    expect(terminusPositionAction({ ...view, placement: "away" })).toBeUndefined();
  });

  it("offers the terminus only while the Task is standing somewhere", () => {
    expect(terminusPositionAction(view))
      .toEqual({ label: "Mark every step cleared", passedMilestoneCount: 3 });
    expect(terminusPositionAction({ ...view, placement: "done" })).toBeUndefined();
  });
});
