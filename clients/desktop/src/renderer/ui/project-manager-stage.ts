import type { DeliveryStageDto, DeliveryStageKind, ProjectEnvironmentDto, ProjectManagerBoardResult } from "@termloop/contract/current";

export const STAGE_LABELS: Record<DeliveryStageKind, string> = {
  toDo: "To do",
  inProgress: "In progress",
  inReview: "In review",
  merged: "Merged",
  deployed: "Deployed",
  live: "Live",
  done: "Done",
};

export type StageStepState = "passed" | "current" | "ahead";

export type StageStep = { id: string; title: string; state: StageStepState; detail: string | null };

/// The daemon's stage of one Task, if the board has it.
export function projectManagerStage(taskId: string, board: ProjectManagerBoardResult | null): DeliveryStageDto | undefined {
  return board?.stages.find((stage) => stage.taskId === taskId);
}

/// A stage as one short label, naming the environment it reached.
export function stageLabel(stage: DeliveryStageDto): string {
  const label = STAGE_LABELS[stage.stage];
  return stage.environment && (stage.stage === "deployed" || stage.stage === "live") ? `${label} · ${stage.environment}` : label;
}

/// The steps from to do to done, with one deploy step per listed
/// non-production environment (or a single one without a list). Steps before
/// the Task's stage are passed; a done Task passed every step.
export function projectManagerStageTrack(
  stage: DeliveryStageDto | undefined,
  environments: readonly ProjectEnvironmentDto[],
): StageStep[] {
  const staging = environments.filter((environment) => !environment.production);
  const production = environments.find((environment) => environment.production);
  const steps: { id: string; title: string; kind: DeliveryStageKind; environment?: string }[] = [
    { id: "toDo", title: STAGE_LABELS.toDo, kind: "toDo" },
    { id: "inProgress", title: STAGE_LABELS.inProgress, kind: "inProgress" },
    { id: "inReview", title: STAGE_LABELS.inReview, kind: "inReview" },
    { id: "merged", title: STAGE_LABELS.merged, kind: "merged" },
    ...(staging.length > 0
      ? staging.map((environment) => ({ id: `deployed:${environment.name}`, title: `On ${environment.name}`, kind: "deployed" as const, environment: environment.name }))
      : [{ id: "deployed", title: STAGE_LABELS.deployed, kind: "deployed" as const }]),
    { id: "live", title: production ? `Live on ${production.name}` : STAGE_LABELS.live, kind: "live" },
    { id: "done", title: STAGE_LABELS.done, kind: "done" },
  ];
  const kind = stage?.stage ?? "toDo";
  const environment = stage?.environment?.toLowerCase();
  let current = steps.findIndex((step) => step.kind === kind
    && (kind !== "deployed" || !step.environment || step.environment.toLowerCase() === environment));
  // An environment the list does not name stands at the first deploy step.
  if (current < 0) current = steps.findIndex((step) => step.kind === kind);
  const done = kind === "done";
  return steps.map((step, index) => ({
    id: step.id,
    title: step.title,
    state: done || index < current ? "passed" : index === current ? "current" : "ahead",
    detail: index === current && !done && stage?.environment && step.environment === undefined && kind === "deployed"
      ? stage.environment
      : null,
  }));
}
