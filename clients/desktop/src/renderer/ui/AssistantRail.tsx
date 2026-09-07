import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { assistantRefusalMessage, isRevisionConflict } from "./StewardPanel.js";
import {
  adoptTemplateInto,
  changeMilestoneRetryAt,
  moveMilestoneToSlot,
  playbookDraftFromDto,
  playbookRefusalMessage,
  playbookRetryChoiceLabel,
  playbookRetryChoices,
  playbookStationApproverCaption,
  PLAYBOOK_TEMPLATES,
  removeMilestoneAt,
  resolvePlaybookSave,
  switchToSavedPipeline,
  type PlaybookDraft,
  type PlaybookTemplate,
  type PlaybookUpdateOutcome,
} from "./playbook-policy.js";
import type {
  AgentCapabilityDto,
  StewardAgentId,
  StewardConfigurationDeleteResult,
  StewardConfigurationDto,
  StewardConfigurationGetResult,
  StewardConfigurationSetResult,
  RoutineConfigurationCreateParams,
  RoutineConfigurationDeleteResult,
  RoutineConfigurationDto,
  RoutineConfigurationListResult,
  RoutineConfigurationMutationResult,
  RoutineConfigurationUpdateParams,
  RoutineHealthDto,
  PlaybookDto,
  PlaybookGetResult,
  PlaybookRuntimeResult,
  PlaybookTaskPositionSetParams,
  PlaybookTaskPositionSetResult,
  PlaybookUpdateParams,
  RoutineRunNowResult,
  RoutineRuntimeListResult,
} from "@termloop/contract/current";
import type { AgentStatus, Session, Task } from "../model.js";
import {
  playbookBuilderSession,
  routineBuilderSession,
  routinePromptImproverSession,
} from "../prompt-improver-session-link.js";
import { AssistantTaskRow, AssistantTaskTail, assistantTaskPlacement } from "./AssistantTaskRows.js";
import { Icon } from "./Icon.js";
import {
  ConfigurationVersions,
  PromptImproveButton,
  promptImprovementActionLabel,
  usePromptImprovement,
  type PromptImprovement,
} from "./PromptImprovement.js";
import { persistentAssistantStatus, routineDisplayStatus, statusExplanation } from "./assistant-status.js";

export function isAssistantSession(session: Session): boolean {
  const template = session.process.template_ref;
  return template === "builtin.assistant.activation"
    || template === "builtin.steward.executor";
}

export type AssistantView = "chat" | "terminal" | "configuration" | "context" | "builder";
export type AssistantSelection =
  | { kind: "steward"; initialView?: "chat" | "terminal" | "configuration" | "builder" }
  | { kind: "routine"; routineId: string; initialView?: "context" };

export type AssistantLaunchDefaults = Readonly<{
  model: string;
  permission: StewardConfigurationDto["permission"];
  reasoning: StewardConfigurationDto["reasoning"];
}>;

export function defaultAssistantLaunchSelection(agentId: StewardAgentId): AssistantLaunchDefaults {
  return agentId === "claude"
    ? { model: "sonnet", permission: "bypassPermissions", reasoning: "medium" }
    : { model: "gpt-5.6-luna", permission: "bypassPermissions", reasoning: "medium" };
}

type PlaybookTaskPositionSetOutcome =
  | { ok: true; result: PlaybookTaskPositionSetResult }
  | { ok: false; code: string | undefined; message: string };

/** One sidebar drop is one current-state position write followed by an exact
    Task-targeted check request. Returning a warning means the durable move
    landed but the immediate check could not start, so callers must not retry
    the position write as though it failed. */
export async function moveTaskToPlaybookStepAndCheck(
  projectId: string,
  taskId: string,
  passedMilestoneCount: number,
  routineId: string,
  deps: {
    getPlaybook(): Promise<PlaybookGetResult>;
    setPosition(params: PlaybookTaskPositionSetParams): Promise<PlaybookTaskPositionSetOutcome>;
    runNow(routineId: string, taskId: string): Promise<RoutineRunNowResult>;
  },
): Promise<string | undefined> {
  const latest = await deps.getPlaybook();
  if (!latest.playbook) throw new Error("The Project has no active Playbook.");
  const outcome = await deps.setPosition({
    projectId,
    taskId,
    passedMilestoneCount,
    expectedPlaybookRevision: latest.playbook.revision,
    expectedRevision: latest.stateRevision,
  });
  if (!outcome.ok) {
    if (outcome.code === "conflict") throw new Error("state revision changed");
    throw new Error(outcome.message);
  }
  try {
    await deps.runNow(routineId, taskId);
    return undefined;
  } catch (cause) {
    return `Task moved, but its immediate check could not start: ${assistantRefusalMessage(cause)}`;
  }
}

export function assistantInitialView(selection: AssistantSelection): AssistantView {
  if (selection.kind === "steward") {
    if (selection.initialView === "terminal") return "chat";
    return selection.initialView ?? "chat";
  }
  if (selection.initialView) return selection.initialView;
  return "context";
}

export function assistantSelectionMatches(
  current: AssistantSelection | undefined,
  candidate: AssistantSelection,
): boolean {
  if (!current || current.kind !== candidate.kind) return false;
  if (current.kind === "routine" && candidate.kind === "routine") return current.routineId === candidate.routineId;
  return current.kind === "steward";
}

export function routineLastRunLabel(lastAttemptAtEpochMs: number | null): string {
  if (lastAttemptAtEpochMs === null) return "never run";
  return `last run ${new Date(lastAttemptAtEpochMs).toLocaleString()}`;
}

export function routineIntervalLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `Every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `Every ${seconds / 60}m`;
  return `Every ${seconds}s`;
}

export function customRoutineParams(
  projectId: string,
  name: string,
  intervalMinutes: number,
  expectedRevision: number,
): RoutineConfigurationCreateParams {
  return {
    projectId,
    triggerMode: "schedule",
    name: name.trim(),
    scheduleIntervalSeconds: intervalMinutes * 60,
    whileWaiting: { mode: "off", instructions: "" },
    expectedRevision,
  };
}

export function openCheckingStewardTerminal(
  status: ReturnType<typeof routineDisplayStatus> | undefined,
  steward: StewardConfigurationDto,
  selectSession: (sessionId: string) => void,
  openDetails: (selection: AssistantSelection) => void,
): boolean {
  if (status?.tone !== "checking" || !steward.executorSessionId) return false;
  selectSession(steward.executorSessionId);
  openDetails({ kind: "steward", initialView: "terminal" });
  return true;
}

export function persistentAssistantIsActive(status: AgentStatus | undefined): boolean {
  return status?.status === "working"
    || status?.status === "compacting"
    || status?.status === "awaitingInput";
}

/** The Project's scheduled Routines: the ones that go looking for work on a
    cadence and can open a Task. A Playbook step's on-demand completion Routine
    is listed separately. */
export function routineCatalogRows(
  routines: readonly RoutineConfigurationDto[],
): RoutineConfigurationDto[] {
  return routines.filter((routine) => routine.triggerMode !== "onDemand");
}

/** A step Routine has no schedule at all: it runs for the one focused Task when
    that Task's current step falls due. Passing keeps focus on the same Task's
    next step; waiting yields to another ready Task. With nobody ready it never
    runs. Its stored `scheduleIntervalSeconds` is wire padding for a field every
    Routine record carries, and showing it as a cadence here would be a lie. */
export function stepRoutineCadence(retryDelaySeconds?: number): string {
  return retryDelaySeconds === undefined
    ? "runs when a Task is due"
    : `${routineIntervalLabel(retryDelaySeconds).toLowerCase()} while waiting`;
}

export function stepRoutineTimingLabel(
  routine: RoutineConfigurationDto,
  health: RoutineHealthDto | undefined,
  stepIndex: number | undefined,
  keptPipeline?: string,
  retryDelaySeconds?: number,
): string {
  const last = routineLastRunLabel(health?.lastAttemptAtEpochMs ?? routine.lastAttemptAtEpochMs);
  const cadence = stepRoutineCadence(retryDelaySeconds);
  if (stepIndex !== undefined) return `Step ${stepIndex + 1} · ${cadence} · ${last}`;
  // A pipeline the Project keeps is not on the board, but it still owns this
  // Routine and can be switched back to. Calling it unused
  // reads as an orphan the user could tidy away and forget.
  if (keptPipeline !== undefined) return `Used by kept ${keptPipeline} pipeline · ${cadence} · ${last}`;
  return `No step uses this · ${last}`;
}

/** Which pipeline each on-demand Routine belongs to. The board the Project
    walks gives the step order; kept pipelines retain their Routines so they
    remain available when switched back. */
export function stepRoutineIndex(playbook: PlaybookGetResult["playbook"]): {
  readonly activeRoutineIds: readonly string[];
  readonly keptPipelineByRoutine: ReadonlyMap<string, string>;
  readonly retryDelayByRoutine: ReadonlyMap<string, number>;
} {
  const activeRoutineIds = (playbook?.milestones ?? []).map((milestone) => milestone.routineId);
  const keptPipelineByRoutine = new Map<string, string>();
  const retryDelayByRoutine = new Map<string, number>();
  for (const milestone of playbook?.milestones ?? []) {
    retryDelayByRoutine.set(milestone.routineId, milestone.retryDelaySeconds);
  }
  for (const pipeline of playbook?.savedPipelines ?? []) {
    for (const milestone of pipeline.milestones) {
      if (!retryDelayByRoutine.has(milestone.routineId)) {
        retryDelayByRoutine.set(milestone.routineId, milestone.retryDelaySeconds);
      }
      if (activeRoutineIds.includes(milestone.routineId)) continue;
      if (!keptPipelineByRoutine.has(milestone.routineId)) {
        keptPipelineByRoutine.set(milestone.routineId, pipeline.name);
      }
    }
  }
  return { activeRoutineIds, keptPipelineByRoutine, retryDelayByRoutine };
}

export type PlaybookStepNode = Readonly<{
  routine: RoutineConfigurationDto;
  /** Position on the active board; undefined for a kept or orphaned check. */
  step: number | undefined;
  keptPipeline: string | undefined;
  retryDelaySeconds: number | undefined;
}>;

/** First-run guidance on the rail itself: a Project whose board has no steps
    leads with the Builder agent as the visible door in, instead of leaving
    "Build pipeline with agent" as a small toolbar action. The CTA retires while a
    Builder Session is already running (its own row shows instead), and the
    moment the board has steps. */
export function showPlaybookBuildCta(
  boardStepCount: number,
  improvementWired: boolean,
  builderSessionRunning: boolean,
): boolean {
  return boardStepCount === 0 && improvementWired && !builderSessionRunning;
}

/// First-run gate: with no Playbook there is nothing for the Steward to
/// coordinate, so the row hides its enable/agent controls until the pipeline
/// exists — the "Build pipeline with agent" CTA below is the one action. An
/// already-enabled Steward keeps its controls so it can still be turned off.
export function stewardControlsLocked(stewardEnabled: boolean, boardStepCount: number): boolean {
  return !stewardEnabled && boardStepCount === 0;
}

/// The last first-run step: right after this user's action created the
/// pipeline (Builder apply, template, or kept pipeline), offer the one click
/// that turns the Steward on. Never shown for a Steward already running, and
/// only while the created steps are actually on the board.
export function stewardEnableOfferVisible(
  pipelineJustCreated: boolean,
  stewardEnabled: boolean,
  boardStepCount: number,
): boolean {
  return pipelineJustCreated && !stewardEnabled && boardStepCount > 0;
}

/// After "Build pipeline with agent" launches the Builder, the Session id arrives through
/// the sessions projection later. This decides when the promised terminal focus
/// fires: only while the intent is live and the Builder Session actually exists.
export function playbookBuilderFocusSession(
  focusRequested: boolean,
  builderSessionId: string | undefined,
): string | undefined {
  return focusRequested ? builderSessionId : undefined;
}

/** First creation is a deliberate launch choice, not an implicit reuse of the
    last Quick Action preset. Both first-run entry points share this exact
    setup request; an existing Builder is opened directly elsewhere. */
export function requestPlaybookBuilderSetup(
  setup: (target: import("@termloop/contract/current").AssistantPromptImproverTarget) => void,
): void {
  setup({ surface: "playbook", ownerId: null });
}

/** The Playbook is one Project-level pipeline, so the rail draws it as one
    numbered list in board order. Checks belonging to kept pipelines — or to no step at all — trail
    in their own off-board group instead of interleaving with the steps. */
export function playbookStepBoard(
  routines: readonly RoutineConfigurationDto[],
  index: ReturnType<typeof stepRoutineIndex>,
): { steps: PlaybookStepNode[]; offBoard: PlaybookStepNode[] } {
  const owned = routines.filter((routine) => routine.triggerMode === "onDemand");
  const byId = new Map(owned.map((routine) => [routine.id, routine]));
  const steps = index.activeRoutineIds.flatMap((routineId, at) => {
    const routine = byId.get(routineId);
    if (!routine) return [];
    return [{
      routine,
      step: at,
      keptPipeline: undefined,
      retryDelaySeconds: index.retryDelayByRoutine.get(routineId),
    }];
  });
  const active = new Set(index.activeRoutineIds);
  const offBoard = owned
    .filter((routine) => !active.has(routine.id))
    .map((routine) => ({
      routine,
      step: undefined,
      keptPipeline: index.keptPipelineByRoutine.get(routine.id),
      retryDelaySeconds: index.retryDelayByRoutine.get(routine.id),
    }));
  return { steps, offBoard };
}

export function stewardDeletionQuestion(routines: number): string {
  const routineCopy = routines === 1 ? "1 Routine" : `${routines} Routines`;
  return `Delete the Steward and reset assistants? ${routineCopy}, the Playbook, chat, and assistant sessions will be deleted.`;
}

export function routineTimingLabel(routine: RoutineConfigurationDto, health: RoutineHealthDto | undefined): string {
  const interval = routineIntervalLabel(routine.scheduleIntervalSeconds);
  const last = routineLastRunLabel(health?.lastAttemptAtEpochMs ?? routine.lastAttemptAtEpochMs);
  const next = health?.nextDueAtEpochMs;
  if (routine.enabled && next !== null && next !== undefined) {
    return `${interval} · ${last} · next ${new Date(next).toLocaleString()}`;
  }
  return `${interval} · ${last}`;
}

type Props = {
  projectId: string;
  refreshToken: number;
  sessions: readonly Session[];
  statusesById: ReadonlyMap<string, AgentStatus>;
  tasks: readonly Task[];
  playbookRuntime: PlaybookRuntimeResult | null;
  disabled: boolean;
  selectedSessionId: string | undefined;
  selection: AssistantSelection | undefined;
  agentCapabilities: readonly AgentCapabilityDto[];
  getSteward(): Promise<StewardConfigurationGetResult>;
  setSteward(agentId: StewardAgentId, model: string, permission: StewardConfigurationDto["permission"], reasoning: StewardConfigurationDto["reasoning"], enabled: boolean, systemPrompt: string, expectedRevision: number): Promise<StewardConfigurationSetResult>;
  deleteSteward(expectedRevision: number): Promise<StewardConfigurationDeleteResult>;
  listRoutines(): Promise<RoutineConfigurationListResult>;
  listRuntime(): Promise<RoutineRuntimeListResult>;
  /** The rail is the one place the pipeline is seen and minimally adjusted:
      reorder, recheck cadence, remove, template adoption, and applying the
      Builder activation all go through the same atomic Playbook save. */
  getPlaybook(): Promise<PlaybookGetResult>;
  updatePlaybook(params: PlaybookUpdateParams): Promise<PlaybookUpdateOutcome>;
  setPlaybookTaskPosition(params: PlaybookTaskPositionSetParams): Promise<PlaybookTaskPositionSetOutcome>;
  runRoutineNow(routineId: string, taskId?: string): Promise<RoutineRunNowResult>;
  createRoutine(params: RoutineConfigurationCreateParams): Promise<RoutineConfigurationMutationResult>;
  updateRoutine(params: RoutineConfigurationUpdateParams): Promise<RoutineConfigurationMutationResult>;
  deleteRoutine(routineId: string, expectedRevision: number): Promise<RoutineConfigurationDeleteResult>;
  improvement: PromptImprovement | undefined;
  setupPromptImprovement(target: import("@termloop/contract/current").AssistantPromptImproverTarget): void;
  restartSteward(): Promise<string | null>;
  selectSession(sessionId: string): void;
  openImproverTerminal(sessionId: string): void;
  dismissImproverSession(sessionId: string): void;
  openTask(taskId: string): void;
  openDetails(selection: AssistantSelection): void;
};

type AssistantRailSnapshot = {
  steward: StewardConfigurationGetResult["configuration"];
  stewardRevision: number;
  routines: RoutineConfigurationDto[];
  routineRevision: number;
  health: RoutineHealthDto[];
  playbook: PlaybookDto | null;
};

function emptyAssistantRailSnapshot(): AssistantRailSnapshot {
  return {
    steward: null,
    stewardRevision: 0,
    routines: [],
    routineRevision: 0,
    health: [],
    playbook: null,
  };
}

function assistantRailSnapshot(
  steward: StewardConfigurationGetResult,
  routines: RoutineConfigurationListResult,
  runtime: RoutineRuntimeListResult,
  playbook: PlaybookGetResult,
): AssistantRailSnapshot {
  return {
    steward: steward.configuration,
    stewardRevision: steward.stateRevision,
    routines: routines.configurations,
    routineRevision: routines.stateRevision,
    health: runtime.health,
    playbook: playbook.playbook,
  };
}

export function AssistantRail(props: Props) {
  const [steward, setSteward] = useState<StewardConfigurationGetResult["configuration"]>(null);
  // Every write cites the global store revision, and only mutation handlers
  // read it — never render. A ref, because a retry has to see the revision the
  // refresh just fetched rather than the one its closure captured.
  const revisions = useRef({ steward: 0, routine: 0 });
  const [routines, setRoutines] = useState<RoutineConfigurationDto[]>([]);
  const [health, setHealth] = useState<RoutineHealthDto[]>([]);
  // The saved document itself: the pipeline the rail draws, and the base
  // every inline edit re-reads before writing.
  const [playbookDoc, setPlaybookDoc] = useState<PlaybookDto | null>(null);
  const snapshotsByProject = useRef(new Map<string, AssistantRailSnapshot>());
  const [snapshotProjectId, setSnapshotProjectId] = useState(props.projectId);
  const applySnapshot = useCallback((projectId: string, snapshot: AssistantRailSnapshot) => {
    setSnapshotProjectId(projectId);
    setSteward(snapshot.steward);
    revisions.current.steward = snapshot.stewardRevision;
    setRoutines(snapshot.routines);
    revisions.current.routine = snapshot.routineRevision;
    setHealth(snapshot.health);
    setPlaybookDoc(snapshot.playbook);
  }, []);
  useLayoutEffect(() => {
    applySnapshot(
      props.projectId,
      snapshotsByProject.current.get(props.projectId) ?? emptyAssistantRailSnapshot(),
    );
  }, [applySnapshot, props.projectId]);
  useEffect(() => {
    if (snapshotProjectId !== props.projectId) return;
    snapshotsByProject.current.set(props.projectId, {
      steward,
      stewardRevision: revisions.current.steward,
      routines,
      routineRevision: revisions.current.routine,
      health,
      playbook: playbookDoc,
    });
  }, [health, playbookDoc, props.projectId, routines, snapshotProjectId, steward]);
  const stepIndex = useMemo(() => stepRoutineIndex(playbookDoc), [playbookDoc]);
  const playbookName = playbookDoc?.activePipelineName ?? "";
  const [failed, setFailed] = useState(false);
  const [restartingSteward, setRestartingSteward] = useState(false);
  const [routineDraft, setRoutineDraft] = useState<{ name: string; intervalMinutes: string }>();
  const [mutatingKey, setMutatingKey] = useState<string>();
  const [draggedTaskId, setDraggedTaskId] = useState<string>();
  const [dropRoutineId, setDropRoutineId] = useState<string>();
  const [confirmingSteward, setConfirmingSteward] = useState(false);
  /// Which pipeline step is asking its one removal question right now.
  const [confirmingStepId, setConfirmingStepId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const playbookImprovementTarget = useMemo(() => ({
    surface: "playbook" as const,
    ownerId: null,
  }), []);
  const playbookImprovement = usePromptImprovement(
    props.improvement,
    playbookImprovementTarget,
    { watch: true },
  );
  const playbookBuilder = playbookBuilderSession(props.projectId, props.sessions);
  const playbookBuilderAgent = playbookBuilder?.process.agent_id === "claude"
    ? "claude"
    : playbookBuilder?.process.agent_id === "codex" ? "codex" : "agent";
  /// "Build pipeline with agent" promises the agent's terminal, but the launched Session
  /// reaches the sessions projection asynchronously — remember the intent and
  /// focus the Builder the moment it appears.
  const [focusBuilderOnLaunch, setFocusBuilderOnLaunch] = useState(false);
  const builderFocusTarget = playbookBuilderFocusSession(focusBuilderOnLaunch, playbookBuilder?.id);
  useEffect(() => {
    if (!builderFocusTarget) return;
    setFocusBuilderOnLaunch(false);
    props.selectSession(builderFocusTarget);
  }, [builderFocusTarget]);
  /// First-run funnel state: the built-in template list stays folded behind one
  /// quiet link until asked for, and the Steward turn-on offer appears only
  /// right after this user's action created the pipeline.
  const [templatesRevealed, setTemplatesRevealed] = useState(false);
  const [pipelineJustCreated, setPipelineJustCreated] = useState(false);
  useEffect(() => {
    setRoutineDraft(undefined);
    setConfirmingSteward(false);
    setTemplatesRevealed(false);
    setPipelineJustCreated(false);
    setDraggedTaskId(undefined);
    setDropRoutineId(undefined);
  }, [props.projectId]);
  useEffect(() => {
    let current = true;
    const projectId = props.projectId;
    setFailed(false);
    setActionError(undefined);
    void Promise.all([props.getSteward(), props.listRoutines(), props.listRuntime(), props.getPlaybook()])
      .then(([stewardResult, routineResult, runtimeResult, playbookResult]) => {
        const snapshot = assistantRailSnapshot(stewardResult, routineResult, runtimeResult, playbookResult);
        snapshotsByProject.current.set(projectId, snapshot);
        if (current) applySnapshot(projectId, snapshot);
      })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [applySnapshot, props.projectId, props.refreshToken]);
  const sessions = useMemo(() => new Map(props.sessions.map((session) => [session.id, session])), [props.sessions]);
  const healthByRoutine = useMemo(() => new Map(health.map((value) => [value.routineId, value])), [health]);
  const capabilityByAgent = useMemo(() => new Map(props.agentCapabilities.map((capability) => [capability.agent_id, capability])), [props.agentCapabilities]);
  const renderedTaskRoutineIds = useMemo(() => {
    return new Set(routines
      .filter((routine) => routine.triggerMode === "onDemand")
      .map((routine) => routine.id));
  }, [routines]);
  const taskPlacement = useMemo(
    () => assistantTaskPlacement(props.tasks, props.playbookRuntime, renderedTaskRoutineIds),
    [props.tasks, props.playbookRuntime, renderedTaskRoutineIds],
  );

  const refreshSnapshots = async () => {
    const [stewardResult, routineResult, runtimeResult, playbookResult] = await Promise.all([
      props.getSteward(), props.listRoutines(), props.listRuntime(), props.getPlaybook(),
    ]);
    const snapshot = assistantRailSnapshot(stewardResult, routineResult, runtimeResult, playbookResult);
    snapshotsByProject.current.set(props.projectId, snapshot);
    applySnapshot(props.projectId, snapshot);
  };

  // One in-flight sidebar mutation at a time.
  //
  // A write cites the global store revision, which moves for reasons the user
  // never caused — the Steward writing, a Routine finishing, another window.
  // The intent is unchanged, so a lost race is answered by reading the current
  // revision and doing it again rather than by asking the user to click again.
  // It is tried a few times because one retry loses a busy Project's race often
  // enough to look like a broken button. A refusal is different: it is the
  // daemon saying why, in words the user can act on, so it is shown as written.
  const guard = async (key: string, action: () => Promise<void>): Promise<boolean> => {
    setMutatingKey(key);
    setActionError(undefined);
    const attempt = async (remaining: number): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (cause) {
        // Read the current revisions first: a retry has to cite them, and a
        // refusal is worth showing against a fresh snapshot either way.
        await refreshSnapshots().catch(() => { /* the next reload recovers it */ });
        if (remaining === 0 || !isRevisionConflict(cause)) {
          setActionError(assistantRefusalMessage(cause));
          return false;
        }
        return attempt(remaining - 1);
      }
    };
    try {
      return await attempt(3);
    } finally {
      setMutatingKey((current) => current === key ? undefined : current);
    }
  };

  const beginTaskDrag = (task: Task, event: DragEvent<HTMLButtonElement>) => {
    if (props.disabled || mutatingKey !== undefined || task.status !== "open") {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-termloop-task-id", task.id);
    event.dataTransfer.setData("text/plain", task.id);
    setDraggedTaskId(task.id);
    setDropRoutineId(undefined);
    setActionError(undefined);
  };
  const endTaskDrag = () => {
    setDraggedTaskId(undefined);
    setDropRoutineId(undefined);
  };
  const dropTaskAtStep = (
    routine: RoutineConfigurationDto,
    passedMilestoneCount: number,
    event: DragEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("application/x-termloop-task-id") || draggedTaskId;
    endTaskDrag();
    if (!taskId || props.disabled || mutatingKey !== undefined) return;
    const task = props.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status !== "open") return;
    void guard(`playbook-position-${taskId}`, async () => {
      const warning = await moveTaskToPlaybookStepAndCheck(
        props.projectId,
        taskId,
        passedMilestoneCount,
        routine.id,
        {
          getPlaybook: props.getPlaybook,
          setPosition: props.setPlaybookTaskPosition,
          runNow: (routineId, selectedTaskId) => props.runRoutineNow(routineId, selectedTaskId),
        },
      );
      if (warning) setActionError(warning);
      await refreshSnapshots();
    });
  };

  const applySteward = (agentId: StewardAgentId, enabled: boolean) => guard("steward", async () => {
    const launch = steward?.agentId === agentId
      ? { model: steward.model, permission: steward.permission, reasoning: steward.reasoning }
      : defaultAssistantLaunchSelection(agentId);
    const result = await props.setSteward(
      agentId,
      launch.model,
      launch.permission,
      launch.reasoning,
      enabled,
      steward?.systemPrompt ?? "",
      revisions.current.steward,
    );
    setSteward(result.configuration);
    revisions.current.steward = result.stateRevision;
  });
  const removeSteward = () => guard("steward", async () => {
    const result = await props.deleteSteward(revisions.current.steward);
    setSteward(null);
    setRoutines([]);
    setHealth([]);
    setPlaybookDoc(null);
    setConfirmingSteward(false);
    setPipelineJustCreated(false);
    setTemplatesRevealed(false);
    revisions.current.steward = result.stateRevision;
    revisions.current.routine = result.stateRevision;
  });
  const toggleRoutine = (
    routine: RoutineConfigurationDto,
    enabled: boolean,
  ) => guard(`routine-${routine.id}`, async () => {
    const result = await props.updateRoutine({
      routineId: routine.id,
      triggerMode: routine.triggerMode,
      name: routine.name,
      instructions: routine.instructions,
      whileWaiting: routine.whileWaiting,
      enabled,
      scheduleIntervalSeconds: routine.scheduleIntervalSeconds,
      expectedRevision: revisions.current.routine,
    });
    setRoutines((values) => [
      ...values.filter((candidate) => candidate.id !== result.configuration.id),
      result.configuration,
    ]);
    revisions.current.routine = result.stateRevision;
  });
  const openRoutine = (routine: RoutineConfigurationDto) =>
    props.openDetails({ kind: "routine", routineId: routine.id });
  const createRoutine = (draft: NonNullable<typeof routineDraft>) => {
    const name = draft.name.trim();
    const intervalMinutes = Number(draft.intervalMinutes);
    if (!name || new TextEncoder().encode(name).length > 80) {
      setActionError("Give the Routine a name up to 80 bytes.");
      return;
    }
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
      setActionError("Choose an interval from 1 minute to 24 hours.");
      return;
    }
    guard("create-routine", async () => {
      const result = await props.createRoutine(customRoutineParams(
        props.projectId,
        name,
        intervalMinutes,
        revisions.current.routine,
      ));
      setRoutines((values) => [...values, result.configuration]);
      revisions.current.routine = result.stateRevision;
      setRoutineDraft(undefined);
      props.openDetails({ kind: "routine", routineId: result.configuration.id, initialView: "context" });
    });
  };
  const removeRoutine = (routine: RoutineConfigurationDto) => {
    guard(`routine-${routine.id}`, async () => {
      // One write: the daemon deletes a Routine whatever state it is in, so
      // turning it off first would only widen the window for losing the race.
      const result = await props.deleteRoutine(routine.id, revisions.current.routine);
      setRoutines((values) => values.filter((candidate) => candidate.id !== routine.id));
      revisions.current.routine = result.stateRevision;
    });
  };

  /* ---- Inline Playbook edits. Every gesture is one atomic document save:
     re-read the latest Playbook, apply the one local change, submit against
     the just-read revisions. guard() retries a lost revision race, and the
     mutation function re-derives from the fresh read each attempt. */
  const savePlaybook = (key: string, mutate: (draft: PlaybookDraft) => PlaybookDraft | undefined) =>
    guard(key, async () => {
      const latest = await props.getPlaybook();
      const draft = playbookDraftFromDto(latest.playbook);
      const next = mutate(draft);
      if (!next) return;
      const decision = resolvePlaybookSave(
        props.projectId,
        next,
        latest.playbook?.revision ?? 0,
        latest,
      );
      if (decision.kind === "conflict") throw new Error("state revision changed");
      const outcome = await props.updatePlaybook(decision.params);
      if (!outcome.ok) {
        if (outcome.code === "conflict") throw new Error("state revision changed");
        throw new Error(playbookRefusalMessage(outcome.message));
      }
      setPlaybookDoc(outcome.result.playbook);
      await refreshSnapshots();
    });
  const moveStep = (index: number, direction: -1 | 1) =>
    savePlaybook(`playbook-move-${index}`, (draft) =>
      moveMilestoneToSlot(draft, index, direction < 0 ? index - 1 : index + 2));
  const changeStepRetry = (index: number, retryDelaySeconds: number) =>
    savePlaybook(`playbook-retry-${index}`, (draft) => changeMilestoneRetryAt(draft, index, retryDelaySeconds));
  const removeStep = (index: number) =>
    savePlaybook(`playbook-remove-${index}`, (draft) => removeMilestoneAt(draft, index));
  const adoptPlaybookTemplate = (template: PlaybookTemplate) =>
    void savePlaybook(`playbook-adopt-${template.id}`, (draft) => adoptTemplateInto(draft, template))
      .then((applied) => { if (applied) setPipelineJustCreated(true); });
  const resumeKeptPipeline = (name: string) =>
    void savePlaybook("playbook-resume", (draft) => switchToSavedPipeline(draft, name))
      .then((applied) => { if (applied) setPipelineJustCreated(true); });

  const agentSwitch = (rowKey: string, name: string, currentAgent: StewardAgentId | null, pick: (agentId: StewardAgentId) => void) =>
    <span className="ar-agent-switch" role="group" aria-label={`${name} agent`}>
      {(["claude", "codex"] as const).map((agentId) => {
        const available = capabilityByAgent.get(agentId)?.available ?? false;
        const agentName = agentId === "claude" ? "Claude" : "Codex";
        return <button key={agentId} type="button"
          className={`ar-agent-pick agent-${agentId}${currentAgent === agentId ? " selected" : ""}${available ? "" : " unavailable"}`}
          aria-pressed={currentAgent === agentId}
          aria-label={`Use ${agentName} for ${name}`}
          title={`${agentName}${available ? "" : " · CLI not detected"}`}
          disabled={mutatingKey === rowKey || currentAgent === agentId}
          onClick={() => pick(agentId)}><Icon name={agentId} /></button>;
      })}
    </span>;

  const powerSwitch = (rowKey: string, name: string, enabled: boolean, toggle: (next: boolean) => void) =>
    <label className="ar-power" title={enabled ? `Turn ${name} off` : `Turn ${name} on`}>
      <input type="checkbox" checked={enabled} disabled={mutatingKey === rowKey}
        aria-label={`${name} enabled`} onChange={(event) => toggle(event.target.checked)} />
      <span className="ap-switch" aria-hidden="true" />
    </label>;

  const assistantRow = () => {
    const title = "Project Steward";
    const sessionId = steward?.executorSessionId ?? null;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const enabled = steward?.enabled ?? false;
    const agentStatus = sessionId ? props.statusesById.get(sessionId) : undefined;
    const status = persistentAssistantStatus({
      enabled,
      running: session?.lifecycle_state === "running",
      restarting: restartingSteward,
      active: persistentAssistantIsActive(agentStatus),
      generatedInputDelivery: agentStatus?.generatedInputDelivery,
    });
    const selection = { kind: "steward" as const };
    return <div className={`ar-row${assistantSelectionMatches(props.selection, selection) ? " selected" : ""}${enabled ? "" : " off"}`}>
      <button type="button" className="ar-main" disabled={firstRunLocked}
        title={firstRunLocked ? "Build the Playbook below first — the Steward turns on once it exists" : statusExplanation(status)}
        onClick={() => props.openDetails(selection)}>
        <span className={`ar-avatar${steward?.agentId ? ` agent-${steward.agentId}` : ""}`} aria-hidden="true">
          <Icon name={steward?.agentId ?? "agent"} />
          <i className={`ar-dot ${status.tone}`} />
        </span>
        <span className="ar-copy">
          <strong>{title}</strong>
          <small>{confirmingSteward
            ? <em className="ar-state danger">{stewardDeletionQuestion(routines.length)}</em>
            : <><em className={`ar-state ${status.tone}`}>{status.label}</em>
              <span>{status.detail ?? (firstRunLocked ? "turns on after the Playbook" : steward ? "coordinator" : "Not configured")}</span></>}
          </small>
        </span>
      </button>
      <span className="ar-controls">
        <span className="ar-quick">
          <button type="button" className="ar-action" aria-label={`Restart ${title}`}
            title={`Restart ${title}`} disabled={!enabled || restartingSteward} onClick={() => {
              setRestartingSteward(true);
              void props.restartSteward().then((nextSessionId) => {
                if (!nextSessionId) return;
                props.selectSession(nextSessionId);
                props.openDetails({ kind: "steward", initialView: "terminal" });
              }).finally(() => setRestartingSteward(false));
            }}><Icon name="reopen" /></button>
          <button type="button" className="ar-action" aria-label={`Open ${title} terminal`} title={`Open ${title} terminal`}
            disabled={!sessionId || !session} onClick={() => {
              if (!sessionId || !session) return;
              props.selectSession(sessionId);
              props.openDetails({ kind: "steward", initialView: "terminal" });
            }}><Icon name="terminal" /></button>
          {steward && confirmingSteward ? <button type="button" className="ar-action" aria-label={`Keep ${title}`}
            title={`Keep ${title}`} onClick={() => setConfirmingSteward(false)}><Icon name="close" /></button> : null}
          {steward ? <button type="button" className={`ar-action danger${confirmingSteward ? " armed" : ""}`}
            aria-label={confirmingSteward ? `Yes, delete ${title} and reset assistants` : `Remove ${title}`}
            title={confirmingSteward ? `Yes, delete ${title} and reset assistants` : `Remove ${title}`}
            disabled={mutatingKey === "steward"}
            onClick={() => {
              if (!confirmingSteward) { setConfirmingSteward(true); setActionError(undefined); return; }
              void removeSteward();
            }}><Icon name="trash" /></button> : null}
        </span>
        {firstRunLocked ? null : <>
          {powerSwitch("steward", title, enabled, (next) => applySteward(steward?.agentId ?? "codex", next))}
          {agentSwitch("steward", title, steward?.agentId ?? null, (next) => applySteward(next, enabled))}
        </>}
      </span>
    </div>;
  };

  /** One station on the Project pipeline. On-board steps are numbered the way
      the delivery board numbers them; off-board checks share the row shape but
      sit dimmed in their own trailing group. */
  const stepNode = (node: PlaybookStepNode) => {
    const { routine, step, keptPipeline } = node;
    const current = healthByRoutine.get(routine.id);
    const selection = { kind: "routine" as const, routineId: routine.id };
    const improver = routinePromptImproverSession(props.projectId, routine, routines, props.sessions);
    const improverAgent = improver?.process.agent_id === "claude"
      ? "claude"
      : improver?.process.agent_id === "codex" ? "codex" : "agent";
    const status = routineDisplayStatus(routine, current);
    const tasksAtStep = taskPlacement.byRoutineId.get(routine.id) ?? [];
    const milestone = step === undefined ? undefined : playbookDoc?.milestones[step];
    const approver = milestone ? playbookStationApproverCaption(milestone) : undefined;
    const armed = step !== undefined && confirmingStepId === routine.id;
    const meta = armed
      ? undefined
      : step !== undefined
        ? `${stepRoutineCadence(node.retryDelaySeconds)}${approver ? ` · ${approver}` : ""}`
        : keptPipeline !== undefined ? `kept · ${keptPipeline}` : "not used by any step";
    const taskDragEnabled = !props.disabled && mutatingKey === undefined;
    return <div
      className={`ar-pl-step${draggedTaskId && step !== undefined ? " task-drag-active" : ""}${dropRoutineId === routine.id ? " task-drop-target" : ""}`}
      key={routine.id}
      data-playbook-drop-position={step}
      onDragOver={step !== undefined && draggedTaskId ? (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      } : undefined}
      onDragEnter={step !== undefined && draggedTaskId ? (event) => {
        event.preventDefault();
        setDropRoutineId(routine.id);
      } : undefined}
      onDragLeave={step !== undefined && draggedTaskId ? (event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropRoutineId((current) => current === routine.id ? undefined : current);
      } : undefined}
      onDrop={step !== undefined ? (event) => dropTaskAtStep(routine, step, event) : undefined}
    >
      <div
        className={`ar-routine playbook-step${assistantSelectionMatches(props.selection, selection) ? " selected" : ""}${routine.enabled ? "" : " off"}${step === undefined ? " unasked" : ""}`}
        title={stepRoutineTimingLabel(routine, current, step, keptPipeline, node.retryDelaySeconds)}>
        <button type="button" className="ar-routine-main" onClick={() => props.openDetails(selection)}>
          <i className={`ar-step-index${status.tone === "checking" ? " checking" : tasksAtStep.length > 0 ? " has-tasks" : ""}`}
            aria-hidden="true">{step === undefined ? "–" : step + 1}</i>
          <span className="ar-copy">
            <strong>{routine.name}</strong>
            <small>{armed
              ? <em className="ar-state danger">Remove this step? Its Routine goes with it.</em>
              : <span>{meta}</span>}</small>
          </span>
        </button>
        <span className="ar-step-actions">
          {status.tone === "attention" ? <span className="ar-flag attention" title={statusExplanation(status)}>{status.label}</span> : null}
          {step !== undefined ? <span className="ar-step-tools">
            <button type="button" className="ar-action" aria-label={`Move step ${step + 1} up`}
              title="Move step up" disabled={playbookBusy || step === 0}
              onClick={() => moveStep(step, -1)}>↑</button>
            <button type="button" className="ar-action" aria-label={`Move step ${step + 1} down`}
              title="Move step down" disabled={playbookBusy || step === board.steps.length - 1}
              onClick={() => moveStep(step, 1)}>↓</button>
            {node.retryDelaySeconds !== undefined ? <select className="ar-step-retry"
              aria-label={`Recheck interval for step ${step + 1}`}
              title="How often this step is rechecked while a Task waits at it"
              value={node.retryDelaySeconds} disabled={playbookBusy}
              onChange={(event) => changeStepRetry(step, Number(event.target.value))}>
              {playbookRetryChoices(node.retryDelaySeconds).map((seconds) =>
                <option key={seconds} value={seconds}>{playbookRetryChoiceLabel(seconds)}</option>)}
            </select> : null}
            {armed ? <button type="button" className="ar-action" aria-label={`Keep step ${step + 1}`}
              title="Keep this step" onClick={() => setConfirmingStepId(undefined)}><Icon name="close" /></button> : null}
            <button type="button" className={`ar-action danger${armed ? " armed" : ""}`}
              aria-label={armed ? `Yes, remove step ${step + 1}` : `Remove step ${step + 1}`}
              title={armed ? "Yes, remove this step" : "Remove this step from the pipeline"}
              disabled={playbookBusy}
              onClick={() => {
                if (!armed) { setConfirmingStepId(routine.id); setActionError(undefined); return; }
                setConfirmingStepId(undefined);
                void removeStep(step);
              }}><Icon name="trash" /></button>
          </span> : null}
          {status.tone === "checking" && steward?.executorSessionId ? <button type="button"
            className="ar-flag checking actionable"
            aria-label="Open Project Steward terminal"
            title="Open Project Steward terminal"
            onClick={() => openCheckingStewardTerminal(status, steward, props.selectSession, props.openDetails)}>{status.label}</button>
            : null}
          {improver ? <span className={`ar-step-improver-group${props.selectedSessionId === improver.id ? " selected" : ""}`}>
            <button type="button"
              className="ar-step-improver"
              aria-label={`Open ${improver.process.agent_id ?? "agent"} improving ${routine.name} instructions`}
              title={`Open ${improver.name ?? "instructions improver"} terminal`}
              onClick={() => props.openImproverTerminal(improver.id)}>
              <Icon name={improverAgent} />
              <span>Improving</span>
              <i className="ready" aria-hidden="true" />
            </button>
            <button type="button"
              className="ar-step-improver-close"
              aria-label={`Close ${improver.name ?? "instructions improver"}`}
              title="Stop improver"
              onClick={() => props.dismissImproverSession(improver.id)}>
              <Icon name="close" />
            </button>
          </span> : null}
        </span>
      </div>
      {dropRoutineId === routine.id ? <div className="ar-step-drop-hint" role="status">
        Move here and check now
      </div> : null}
      {tasksAtStep.length > 0 ? <div className="ar-step-tasks" role="list" aria-label={`Tasks at ${routine.name}`}>
        {tasksAtStep.map((task) => <AssistantTaskRow
          key={task.id}
          task={task}
          processingTaskId={props.playbookRuntime?.processingTaskId ?? null}
          openTask={props.openTask}
          dragging={draggedTaskId === task.id}
          beginDrag={taskDragEnabled ? beginTaskDrag : undefined}
          endDrag={endTaskDrag}
        />)}
      </div> : null}
    </div>;
  };

  const board = playbookStepBoard(routines, stepIndex);
  /// One first-run lock for the whole assistant hierarchy: until the Playbook
  /// exists the Steward row remains an inert status line.
  const firstRunLocked = stewardControlsLocked(steward?.enabled ?? false, board.steps.length);
  const playbookBusy = mutatingKey?.startsWith("playbook-") ?? false;
  const startPlaybookBuilder = () => {
    /* Shared by the toolbar button and the first-run CTA below. */
    void playbookImprovement.start().then((failure) => {
      if (failure) {
        setActionError(failure);
        return;
      }
      setFocusBuilderOnLaunch(true);
      props.openDetails({ kind: "steward", initialView: "builder" });
    });
  };
  const setupPlaybookBuilder = () => requestPlaybookBuilderSetup(props.setupPromptImprovement);
  const buildCtaVisible = showPlaybookBuildCta(
    board.steps.length,
    props.improvement !== undefined,
    playbookBuilder !== undefined,
  );

  return <section className="assistant-rail" aria-label="Project assistants">
    <div className="ar-head">
      <span>Project assistant</span>
      <i className="ar-rule" aria-hidden="true" />
      {firstRunLocked ? null : <button type="button" className="ar-config" aria-label="Configure Steward prompts" title="Configure Steward prompts"
        onClick={() => props.openDetails({ kind: "steward", initialView: "configuration" })}><Icon name="edit" /></button>}
    </div>
    {failed ? <p className="assistant-empty">Assistant status is unavailable.</p> : null}
    {actionError ? <p className="ar-add-error" role="alert">{actionError}</p> : null}
    {assistantRow()}
    <div className="ar-tree" aria-label="Steward routines">
      <div className="ar-playbook" aria-label="Project Playbook">
        <div className="ar-playbook-controls">
          <span className="ar-routines-label">{playbookName ? `Playbook · ${playbookName}` : "Playbook"}</span>
          {props.improvement ? <span className="ar-routines-tools">
            {buildCtaVisible || playbookBuilder ? null : <button type="button" className="ar-routines-improve"
              disabled={playbookImprovement.busy}
              title="The Playbook is edited by the Builder agent — describe the pipeline you want"
              onClick={startPlaybookBuilder}><Icon name="sparkles" />{board.steps.length > 0 ? promptImprovementActionLabel("playbook") : "Build pipeline with agent"}</button>}
            <button type="button" className="ar-routines-improve setup"
              disabled={playbookImprovement.busy}
              title="Choose the agent and launch settings for the Playbook Builder"
              aria-label="Playbook Builder agent settings"
              onClick={() => props.setupPromptImprovement({ surface: "playbook", ownerId: null })}>▾</button>
          </span> : null}
        </div>
        {playbookBuilder ? <div className={`ar-pl-builder-live${props.selectedSessionId === playbookBuilder.id ? " selected" : ""}`}>
          <button type="button" className="ar-pl-builder-open"
            aria-label={`Open ${playbookBuilder.process.agent_id ?? "agent"} building the Project Playbook`}
            title="Open the Builder conversation"
            onClick={() => {
              props.selectSession(playbookBuilder.id);
              props.openDetails({ kind: "steward", initialView: "builder" });
            }}>
            <span className="ar-pl-builder-avatar"><Icon name={playbookBuilderAgent} /><i className="live" aria-hidden="true" /></span>
            <span className="ar-copy">
              <strong>Builder is drafting your pipeline</strong>
              <small>Open the conversation to answer its questions.</small>
            </span>
            <span className="ar-pl-builder-go" aria-hidden="true">Open</span>
          </button>
          <button type="button" className="ar-pl-builder-stop"
            aria-label="Stop the Builder"
            title="Stop the Builder"
            onClick={() => props.dismissImproverSession(playbookBuilder.id)}>
            <Icon name="close" />
          </button>
        </div> : null}
        <ConfigurationVersions controller={playbookImprovement} reload={refreshSnapshots} />
        {buildCtaVisible ? <button type="button" className="ar-pl-build-cta"
          disabled={playbookImprovement.busy || playbookBusy}
          title="Choose the agent and launch settings, then draft this Project's pipeline"
          onClick={setupPlaybookBuilder}>
          <Icon name="sparkles" />
          <span className="ar-copy">
            <strong>Build pipeline with agent</strong>
            <small>Choose the agent and model, then draft this Project&apos;s pipeline together.</small>
          </span>
        </button> : null}
        {buildCtaVisible ? <ol className="ar-pl-flow" aria-label="How the assistant starts">
          <li>An agent drafts this Project&apos;s pipeline with you</li>
          <li>The Steward turns on and walks Tasks through it</li>
          <li>The Steward verifies each due step and advances the Task</li>
        </ol> : null}
        {stewardEnableOfferVisible(pipelineJustCreated, steward?.enabled ?? false, board.steps.length)
          ? <div className="ar-pl-turn-on">
            <span className="ar-copy">
              <strong>Playbook ready</strong>
              <small>Turn the Steward on to start walking Tasks through it.</small>
            </span>
            <button type="button" className="ar-create-confirm"
              disabled={mutatingKey === "steward"}
              onClick={() => { setPipelineJustCreated(false); applySteward(steward?.agentId ?? "codex", true); }}>Turn on</button>
            <button type="button" className="ar-kind-cancel" aria-label="Not now"
              onClick={() => setPipelineJustCreated(false)}><Icon name="close" /></button>
          </div> : null}
        {board.steps.length > 0
          ? <div className="ar-pipeline">{board.steps.map(stepNode)}</div>
          : playbookBuilder ? null
          : <div className="ar-pl-templates" aria-label="Start the pipeline">
            {(playbookDoc?.savedPipelines ?? []).map((pipeline) => <button key={pipeline.name} type="button"
              className="ar-pl-template kept"
              disabled={props.disabled || playbookBusy}
              title={`Bring “${pipeline.name}” back onto the board.`}
              onClick={() => resumeKeptPipeline(pipeline.name)}>
              <strong>{pipeline.name}</strong>
              <small>kept · {pipeline.milestones.length} steps</small>
            </button>)}
            {firstRunLocked && !templatesRevealed
              ? <button type="button" className="ar-pl-templates-reveal"
                onClick={() => setTemplatesRevealed(true)}>or start from a template…</button>
              : PLAYBOOK_TEMPLATES
                .filter((template) => !(playbookDoc?.savedPipelines ?? []).some((pipeline) => pipeline.name === template.name))
                .map((template) => <button key={template.id} type="button" className="ar-pl-template"
                  disabled={props.disabled || playbookBusy}
                  title={template.summary}
                  onClick={() => adoptPlaybookTemplate(template)}>
                  <strong>{template.name}</strong>
                  <small>{template.draft().milestones.length} steps</small>
                </button>)}
          </div>}
        <AssistantTaskTail
          placement={taskPlacement}
          processingTaskId={props.playbookRuntime?.processingTaskId ?? null}
          openTask={props.openTask}
          draggingTaskId={draggedTaskId}
          beginDrag={!props.disabled && mutatingKey === undefined ? beginTaskDrag : undefined}
          endDrag={endTaskDrag}
        />
        {board.offBoard.length > 0 ? <div className="ar-offboard">
          <span className="ar-routines-label">Off the board · {board.offBoard.length}</span>
          {board.offBoard.map(stepNode)}
        </div> : null}
      </div>
      <div className="ar-branch">
        <div className="ar-routines">
          {/* Scheduled Routines only: the ones that go looking for work on a
              cadence. Playbook step checks live on the pipeline above. */}
          <span className="ar-routines-label">Scheduled checks</span>
          {routineCatalogRows(routines).map((routine) => {
            const current = healthByRoutine.get(routine.id);
            const selection = { kind: "routine" as const, routineId: routine.id };
            const rowKey = `routine-${routine.id}`;
            const status = routineDisplayStatus(routine, current);
            return <div key={routine.id}
              className={`ar-routine${assistantSelectionMatches(props.selection, selection) ? " selected" : ""}${routine.enabled ? "" : " off"}`}
              title={statusExplanation(status)}>
              <button type="button" className="ar-routine-main" disabled={mutatingKey === rowKey}
                onClick={() => openRoutine(routine)}>
                <i className={`ar-pip ${status.tone}`} aria-hidden="true" />
                <span className="ar-copy">
                  <strong>{routine.name}</strong>
                  <small><span>{routineTimingLabel(routine, current)}</span></small>
                </span>
              </button>
              <span className="ar-routine-actions">
                {status.tone === "checking" && steward?.executorSessionId ? <button type="button"
                  className="ar-flag checking actionable"
                  aria-label="Open Project Steward terminal"
                  title="Open Project Steward terminal"
                  onClick={() => openCheckingStewardTerminal(status, steward, props.selectSession, props.openDetails)}>{status.label}</button>
                  : <span className={`ar-flag ${status.tone}`}>{status.label}</span>}
                {powerSwitch(rowKey, routine.name, routine.enabled,
                  (next) => toggleRoutine(routine, next))}
                <button type="button" className="ar-routine-remove" aria-label={`Remove ${routine.name}`}
                  title={`Remove ${routine.name}`} disabled={mutatingKey === rowKey}
                  onClick={() => removeRoutine(routine)}><Icon name="close" /></button>
              </span>
            </div>;
          })}
          <RoutineBuilderControl
            projectId={props.projectId}
            sessions={props.sessions}
            selectedSessionId={props.selectedSessionId}
            improvement={props.improvement}
            mutating={mutatingKey === "build-routine"}
            startSetup={() => props.setupPromptImprovement({ surface: "routineBuilder", ownerId: null })}
            openTerminal={props.openImproverTerminal}
            dismissSession={props.dismissImproverSession}
            reload={refreshSnapshots}
          />
          {routineDraft ? <form className="ar-routine-create" aria-label="Create Project Routine"
            onSubmit={(event) => { event.preventDefault(); createRoutine(routineDraft); }}>
            <input className="ar-routine-name" aria-label="Routine name" placeholder="Routine name" maxLength={80} autoFocus
              value={routineDraft.name} disabled={mutatingKey === "create-routine"}
              onChange={(event) => setRoutineDraft({ ...routineDraft, name: event.target.value })} />
            <label className="ar-routine-interval" title="Run interval in minutes">
              <input type="number" min="1" max="1440" step="1" aria-label="Routine interval in minutes"
                value={routineDraft.intervalMinutes} disabled={mutatingKey === "create-routine"}
                onChange={(event) => setRoutineDraft({ ...routineDraft, intervalMinutes: event.target.value })} />
              <span>m</span>
            </label>
            <button type="submit" className="ar-create-confirm" disabled={mutatingKey === "create-routine"}>Create</button>
            <button type="button" className="ar-kind-cancel" aria-label="Cancel creating Routine"
              disabled={mutatingKey === "create-routine"}
              onClick={() => { setRoutineDraft(undefined); setActionError(undefined); }}><Icon name="close" /></button>
          </form> : <button type="button" className="ar-add sub" onClick={() => {
            setRoutineDraft({ name: "", intervalMinutes: "60" });
            setActionError(undefined);
          }}><Icon name="add" />Create Routine</button>}
        </div>
      </div>
    </div>
  </section>;
}

function RoutineBuilderControl(props: {
  projectId: string;
  sessions: readonly Session[];
  selectedSessionId: string | undefined;
  improvement: PromptImprovement | undefined;
  mutating: boolean;
  startSetup(): void;
  openTerminal(sessionId: string): void;
  dismissSession(sessionId: string): void;
  reload(): void | Promise<void>;
}) {
  const target = useMemo(() => ({
    surface: "routineBuilder" as const,
    ownerId: null,
  }), []);
  const builder = usePromptImprovement(props.improvement, target, { watch: true });
  const session = routineBuilderSession(props.projectId, props.sessions);
  const sessionAgent = session?.process.agent_id === "claude"
    ? "claude"
    : session?.process.agent_id === "codex" ? "codex" : "agent";
  return <div className="ar-routine-builder" aria-label="Project Routine Builder">
    {session ? <span className={`ar-step-improver-group${props.selectedSessionId === session.id ? " selected" : ""}`}>
      <button type="button" className="ar-step-improver" title="Open Routine Builder terminal"
        onClick={() => props.openTerminal(session.id)}>
        <Icon name={sessionAgent} /><span>Routine Builder</span><i className="ready" aria-hidden="true" />
      </button>
      <button type="button" className="ar-step-improver-close" title="Close Builder"
        aria-label="Close Project Routine Builder"
        onClick={() => props.dismissSession(session.id)}><Icon name="close" /></button>
    </span> : null}
    <PromptImproveButton
      improvement={props.improvement}
      busy={builder.busy || props.mutating}
      title={session ? "Resume the Project Routine Builder" : "Build a Routine with an agent"}
      label={session ? "Continue Routine builder" : promptImprovementActionLabel("routineBuilder")}
      start={() => { void builder.start(); }}
      setup={props.startSetup}
    />
    <ConfigurationVersions controller={builder} reload={props.reload} />
  </div>;
}
