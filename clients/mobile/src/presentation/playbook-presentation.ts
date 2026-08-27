import type {
  PlaybookDto,
  PlaybookMilestoneDto,
  PlaybookRuntimeResult,
  PlaybookStepProgressDto,
} from "@termloop/contract/current";

/// One Task's journey through the pipeline its Project is walking, derived the
/// same way the desktop derives it: core says which step a Task waits at, so
/// everything behind that rung is cleared by definition and nothing is inferred
/// from evidence text.

export type TaskStepStanding = "passed" | "waiting" | "ahead";
export type TaskPipelinePlacement = "waiting" | "done" | "away";

export interface TaskStepRoutine {
  name: string;
  enabled: boolean;
}

export interface TaskPipelineStep {
  /// 1-based, because a pipeline is a sequence the reader counts.
  position: number;
  milestone: PlaybookMilestoneDto;
  standing: TaskStepStanding;
  progress: PlaybookStepProgressDto | undefined;
  routine: TaskStepRoutine | undefined;
}

export interface TaskPipelineView {
  pipelineName: string;
  steps: readonly TaskPipelineStep[];
  placement: TaskPipelinePlacement;
  standingAt: number | undefined;
  passedCount: number;
}

function stepStanding(
  placement: TaskPipelinePlacement,
  waitingIndex: number,
  index: number,
  progress: PlaybookStepProgressDto | undefined,
): TaskStepStanding {
  if (placement === "waiting") {
    if (index < waitingIndex) return "passed";
    return index === waitingIndex ? "waiting" : "ahead";
  }
  return progress?.verdict === "passed" ? "passed" : "ahead";
}

export function taskPipelineView(
  playbook: PlaybookDto | null,
  runtime: PlaybookRuntimeResult | null,
  routines: readonly { id: string; name: string; enabled: boolean }[],
  taskId: string,
): TaskPipelineView | undefined {
  if (!playbook || playbook.milestones.length === 0) return undefined;
  const byMilestone = new Map((runtime?.steps ?? []).map((step) => [step.milestoneId, step]));
  const waitingIndex = playbook.milestones.findIndex(
    (milestone) => byMilestone.get(milestone.id)?.waitingTaskIds.includes(taskId) ?? false,
  );
  const placement: TaskPipelinePlacement = waitingIndex >= 0
    ? "waiting"
    : runtime?.doneTaskIds.includes(taskId) === true ? "done" : "away";
  const steps = playbook.milestones.map((milestone, index) => {
    const progress = byMilestone.get(milestone.id)?.progress.find((entry) => entry.taskId === taskId);
    const routine = routines.find((candidate) => candidate.id === milestone.routineId);
    return {
      position: index + 1,
      milestone,
      standing: stepStanding(placement, waitingIndex, index, progress),
      progress,
      routine: routine ? { name: routine.name, enabled: routine.enabled } : undefined,
    };
  });
  return {
    pipelineName: playbook.activePipelineName,
    steps,
    placement,
    standingAt: waitingIndex >= 0 ? waitingIndex + 1 : undefined,
    passedCount: steps.filter((step) => step.standing === "passed").length,
  };
}

export function pipelineProgressLabel(view: TaskPipelineView): string {
  const total = view.steps.length;
  if (view.placement === "done") return `Cleared all ${total}`;
  if (view.placement === "away") return `${view.passedCount} of ${total} cleared`;
  return `Step ${view.standingAt} of ${total}`;
}

/// Coarse minutes, because a phone reads a countdown at a glance and a Routine's
/// next attempt is never precise enough to spend digits on.
export function pipelineRelativeMinutes(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/// When this step last moved, or when it is asked again. A cleared step looks
/// backwards; the standing step looks forwards, because the only thing left to
/// know about it is when it gets checked next.
export function stepTiming(step: TaskPipelineStep, nowEpochMs: number): string | undefined {
  const progress = step.progress;
  if (step.standing === "passed") {
    return progress
      ? `cleared ${pipelineRelativeMinutes(Math.max(0, nowEpochMs - progress.decidedAtEpochMs))} ago`
      : undefined;
  }
  if (step.standing !== "waiting") return undefined;
  const due = progress?.nextAttemptAtEpochMs ?? null;
  if (due === null || due <= nowEpochMs) return "checking next";
  return `next check in ${pipelineRelativeMinutes(due - nowEpochMs)}`;
}

export function stepEvidence(step: TaskPipelineStep): string | undefined {
  const evidence = step.progress?.evidence.trim();
  if (evidence !== undefined && evidence.length > 0) return evidence;
  if (step.standing === "waiting") return "No completion result recorded for this Task yet.";
  return undefined;
}

export interface TaskStepAnswerSource {
  text: string;
  blocked: boolean;
}

/// Who answers this step — and whether anybody can. A step whose Routine is
/// missing or switched off will never move on its own, and that is the one fact
/// worth carrying to a phone.
export function stepAnswerSource(step: TaskPipelineStep): TaskStepAnswerSource {
  if (step.milestone.gate === "human") {
    return step.milestone.approver !== null && step.milestone.approver.length > 0
      ? { text: `${step.milestone.approver} approves this`, blocked: false }
      : { text: "No approver named", blocked: true };
  }
  if (!step.routine) return { text: "No completion Routine", blocked: true };
  return step.routine.enabled
    ? { text: step.routine.name, blocked: false }
    : { text: `${step.routine.name} is off`, blocked: true };
}

/// Running a step's Routine by hand only means anything for the automatic step
/// this Task is standing at. A human gate waits on a person.
export function stepIsCheckable(step: TaskPipelineStep): boolean {
  return step.standing === "waiting"
    && step.milestone.gate === "automatic"
    && step.routine !== undefined
    && step.routine.enabled;
}

/// One state per meter segment, so the header states position as countable
/// blocks instead of a continuous fill the eye has to measure.
export function pipelineSegments(view: TaskPipelineView): readonly TaskStepStanding[] {
  if (view.placement === "done") return view.steps.map(() => "passed");
  return view.steps.map((step) => step.standing);
}

/// The one compact fact a collapsed row prints at its right edge. A cleared
/// step says how long ago it moved; the standing step says what it is waiting
/// on — a stalled answer source outranks any countdown, because "nobody can
/// answer this" is the fact worth a glance. Steps ahead say nothing unless a
/// person will have to approve them.
export function stepRowSummary(step: TaskPipelineStep, nowEpochMs: number): string | undefined {
  if (step.standing === "passed") {
    return step.progress
      ? `${pipelineRelativeMinutes(Math.max(0, nowEpochMs - step.progress.decidedAtEpochMs))} ago`
      : "cleared";
  }
  if (step.standing === "waiting") {
    if (stepAnswerSource(step).blocked) return "stalled";
    if (step.milestone.gate === "human") return "approval";
    const due = step.progress?.nextAttemptAtEpochMs ?? null;
    return due === null || due <= nowEpochMs ? "checking" : `in ${pipelineRelativeMinutes(due - nowEpochMs)}`;
  }
  return step.milestone.gate === "human" ? "approval" : undefined;
}

export interface StepPositionAction {
  label: string;
  passedMilestoneCount: number;
}

/// Moving the Task by hand is a correction, so the wording states the outcome
/// in pipeline terms instead of a placeless "set here". A Task that has left
/// the pipeline cannot be repositioned from the phone at all.
export function stepPositionAction(
  step: TaskPipelineStep,
  placement: TaskPipelinePlacement,
): StepPositionAction | undefined {
  if (placement === "away") return undefined;
  const label = step.standing === "waiting"
    ? "Re-ask this step"
    : step.standing === "passed"
      ? "Move back here"
      : "Skip ahead to here";
  return { label, passedMilestoneCount: step.position - 1 };
}

/// The terminus is a position like any rung: past the final step. Offered only
/// while the Task is actually standing somewhere, because "done" is already
/// true for a done Task and unreachable for one that left the pipeline.
export function terminusPositionAction(view: TaskPipelineView): StepPositionAction | undefined {
  if (view.placement !== "waiting") return undefined;
  return { label: "Mark every step cleared", passedMilestoneCount: view.steps.length };
}
