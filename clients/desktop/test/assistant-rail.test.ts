import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlaybookGetResult, PlaybookRuntimeResult, RoutineConfigurationDto, WorkerConfigurationDto } from "@termloop/contract/current";
import type { AgentStatus, Session, Task } from "../src/renderer/model.js";
import { assistantRefusalMessage } from "../src/renderer/ui/StewardPanel.js";
import {
  rememberPromptImproverSession,
  playbookBuilderSession,
  routineBuilderSession,
  routinePromptImproverSession,
} from "../src/renderer/prompt-improver-session-link.js";
import {
  assistantInitialView,
  assistantSelectionMatches,
  customRoutineParams,
  defaultAssistantLaunchSelection,
  defaultRoutineParams,
  isAssistantSession,
  moveTaskToPlaybookStepAndCheck,
  openCheckingWorkerTerminal,
  persistentAssistantIsActive,
  ROUTINE_CATALOG,
  routineCatalogRows,
  playbookStepBoard,
  playbookBuilderFocusSession,
  requestPlaybookBuilderSetup,
  showPlaybookBuildCta,
  stewardControlsLocked,
  stewardDeletionQuestion,
  stewardEnableOfferVisible,
  stepRoutineCadence,
  stepRoutineTimingLabel,
  routinePresetKey,
  routineTimingLabel,
  workerPingIntervalLabel,
  workerPingIntervalSeconds,
  stepRoutineIndex,
  workerDeletionQuestion,
} from "../src/renderer/ui/AssistantRail.js";
import {
  AssistantTaskRow,
  AssistantTaskTail,
  assistantTaskPlacement,
} from "../src/renderer/ui/AssistantTaskRows.js";

function session(templateRef: string | null): Session {
  return {
    id: "session-1",
    project_id: "project-1",
    name: null,
    kind: "Agent",
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    retryable: false,
    closable: false,
    forkable: false,
    process: {
      program: "claude",
      args: [],
      cwd: "/Users/demo/project",
      agent_id: "claude",
      template_ref: templateRef,
      template_version: templateRef ? 1 : null,
    },
  };
}

describe("Assistant rail Session classification", () => {
  it("names everything removed by the Steward reset confirmation", () => {
    expect(stewardDeletionQuestion(1, 2)).toBe(
      "Delete the Steward and reset assistants? 1 Worker, 2 Routines, the Playbook, chat, and assistant sessions will be deleted.",
    );
    expect(stewardDeletionQuestion(0, 1)).toContain("0 Workers, 1 Routine");
  });

  it("links the live Playbook Builder to its dedicated sidebar row", () => {
    const builder = {
      ...session("builtin.builder.playbook"),
      id: "builder-1",
      name: "build: Project Playbook",
      improver_target: { targetKind: "playbook" as const, targetId: null },
    };
    expect(playbookBuilderSession("project-1", [builder])?.id).toBe("builder-1");
    expect(playbookBuilderSession("another-project", [builder])).toBeUndefined();
    expect(playbookBuilderSession("project-1", [{
      ...builder,
      lifecycle_state: "exited" as const,
    }])).toBeUndefined();
  });

  it("links a Routine instructions improver to its exact Playbook step", () => {
    const first = {
      ...session("builtin.improver.routine-instructions"),
      id: "improver-1",
      name: "improve: Is CI green?",
      process: {
        ...session("builtin.improver.routine-instructions").process,
        agent_id: "codex",
      },
    };
    const second = { ...first, id: "improver-2" };
    const routines = [
      { id: "routine-ci", name: "Is CI green?" },
      { id: "routine-ci-other", name: "Is CI green?" },
    ];
    rememberPromptImproverSession("project-1", {
      surface: "routineInstructions",
      ownerId: "routine-ci",
    }, "improver-2");
    expect(routinePromptImproverSession(
      "project-1",
      routines[0]!,
      routines,
      [first, second],
    )?.id).toBe("improver-2");
  });

  it("links the live Routine Builder to its exact Worker", () => {
    const builder = {
      ...session("builtin.builder.routine"),
      id: "routine-builder-1",
      name: "build: Routine for Ship to production",
      improver_target: { targetKind: "routineBuilder" as const, targetId: "worker-1" },
    };
    const workers = [{ id: "worker-1", name: "Ship to production" }];
    expect(routineBuilderSession("project-1", workers[0]!, workers, [builder])?.id)
      .toBe("routine-builder-1");
    expect(routineBuilderSession(
      "project-1",
      { id: "worker-2", name: "Another Worker" },
      workers,
      [builder],
    )).toBeUndefined();
  });

  it("recovers an unambiguous Routine improver from visible Session provenance", () => {
    const improver = {
      ...session("builtin.improver.routine-instructions"),
      id: "recovered-improver",
      project_id: "project-recovered",
      name: "improve: Is it deployed?",
    };
    const routine = { id: "routine-deploy", name: "Is it deployed?" };
    expect(routinePromptImproverSession(
      "project-recovered",
      routine,
      [routine],
      [improver],
    )?.id).toBe("recovered-improver");
  });

  it("hides a stopped Routine improver while retaining its resumable descriptor", () => {
    const stopped = {
      ...session("builtin.improver.routine-instructions"),
      id: "stopped-improver",
      project_id: "project-stopped",
      name: "improve: Is it deployed?",
      lifecycle_state: "exited" as const,
      retryable: true,
    };
    const routine = { id: "routine-deploy", name: "Is it deployed?" };
    expect(routinePromptImproverSession(
      "project-stopped",
      routine,
      [routine],
      [stopped],
    )).toBeUndefined();
  });

  it("uses provider-specific persistent assistant launch defaults", () => {
    expect(defaultAssistantLaunchSelection("claude")).toEqual({
      model: "sonnet",
      permission: "bypassPermissions",
      reasoning: "medium",
    });
    expect(defaultAssistantLaunchSelection("codex")).toEqual({
      model: "gpt-5.6-luna",
      permission: "bypassPermissions",
      reasoning: "medium",
    });
  });

  it("shows only persistent Steward and Worker terminals", () => {
    expect(isAssistantSession(session("builtin.assistant.activation"))).toBe(true);
    expect(isAssistantSession(session("builtin.steward.executor"))).toBe(true);
    expect(isAssistantSession(session("builtin.worker.executor"))).toBe(true);
    expect(isAssistantSession(session("builtin.tracker.slack"))).toBe(false);
    expect(isAssistantSession(session("builtin.tracker.runtime"))).toBe(false);
    expect(isAssistantSession(session("builtin.agent.interactive"))).toBe(false);
    expect(isAssistantSession(session(null))).toBe(false);
  });

  it("opens assistant content in-place with role-specific default tabs", () => {
    expect(assistantInitialView({ kind: "steward" })).toBe("chat");
    expect(assistantInitialView({ kind: "steward", initialView: "configuration" })).toBe("configuration");
    expect(assistantInitialView({ kind: "steward", initialView: "builder" })).toBe("builder");
    expect(assistantInitialView({ kind: "worker", workerId: "worker-1" })).toBe("terminal");
    expect(assistantInitialView({ kind: "worker", workerId: "worker-1", initialView: "configuration" })).toBe("configuration");
    expect(assistantInitialView({ kind: "routine", routineId: "routine-1" })).toBe("context");
    expect(assistantInitialView({ kind: "steward", initialView: "terminal" })).toBe("chat");
  });

  it("derives the explicit Active or Idle assistant label from structured turn state", () => {
    const status = (value: AgentStatus["status"]): AgentStatus => ({
      sessionId: "session-1",
      status: value,
      source: "hook",
      observedAtEpochMs: 1,
    });
    expect(persistentAssistantIsActive(status("working"))).toBe(true);
    expect(persistentAssistantIsActive(status("compacting"))).toBe(true);
    expect(persistentAssistantIsActive(status("awaitingInput"))).toBe(true);
    expect(persistentAssistantIsActive(status("idle"))).toBe(false);
    expect(persistentAssistantIsActive(undefined)).toBe(false);
  });

  it("places every Assistant Task once and animates only the claimed one", () => {
    const task = (id: string, title: string, status: Task["status"] = "open") => ({
      id,
      project_id: "project-1",
      title,
      status,
      branch: null,
      worktree: null,
    } as Task);
    const runtime = {
      activePipelineName: "Dev PR to production",
      processingTaskId: "task-2",
      steps: [
        { milestoneId: "code", routineId: "routine-code", waitingTaskIds: ["task-1", "task-2"], progress: [], nextAttemptAtEpochMs: null },
        { milestoneId: "deploy", routineId: "routine-deploy", waitingTaskIds: ["task-6"], progress: [], nextAttemptAtEpochMs: null },
      ],
      doneTaskIds: ["task-3"],
      stateRevision: 1,
    } as PlaybookRuntimeResult;
    const tasks = [
      task("task-1", "First Task"),
      task("task-2", "Claimed Task"),
      task("task-3", "Pipeline complete"),
      task("task-4", "Closed Task", "closed"),
      task("task-5", "Awaiting position"),
      task("task-6", "Routine unavailable"),
    ];
    const placement = assistantTaskPlacement(tasks, runtime, new Set(["routine-code"]));
    expect(placement.byRoutineId.get("routine-code")?.map(({ id }) => id)).toEqual(["task-1", "task-2"]);
    expect(placement.byRoutineId.has("routine-deploy")).toBe(false);
    expect(placement.completed.map(({ id }) => id)).toEqual(["task-3"]);
    expect(placement.unplaced.map(({ id }) => id)).toEqual(["task-5", "task-6"]);
    expect(placement.closed.map(({ id }) => id)).toEqual(["task-4"]);
    const allPlaced = [
      ...[...placement.byRoutineId.values()].flat(),
      ...placement.completed,
      ...placement.unplaced,
      ...placement.closed,
    ].map(({ id }) => id);
    expect(allPlaced).toHaveLength(new Set(allPlaced).size);
    expect(allPlaced.sort()).toEqual(tasks.map(({ id }) => id).sort());

    const stepMarkup = (placement.byRoutineId.get("routine-code") ?? [])
      .map((placedTask) => renderToStaticMarkup(AssistantTaskRow({
        task: placedTask,
        processingTaskId: runtime.processingTaskId,
        openTask: () => undefined,
        beginDrag: () => undefined,
        endDrag: () => undefined,
      })))
      .join("");
    const tailMarkup = renderToStaticMarkup(AssistantTaskTail({
      placement,
      processingTaskId: runtime.processingTaskId,
      openTask: () => undefined,
      beginDrag: () => undefined,
      endDrag: () => undefined,
    }));
    const markup = `${stepMarkup}${tailMarkup}`;
    expect(markup.match(/class="assistant-task-row/g)).toHaveLength(tasks.length);
    expect(markup.match(/data-playbook-processing="true"/g)).toHaveLength(1);
    expect(markup.match(/draggable="true"/g)).toHaveLength(5);
    expect(markup.match(/data-playbook-task-id=/g)).toHaveLength(5);
    expect(markup).toContain("assistant-task-row processing");
  });

  it("positions a dropped Task at the chosen step before checking that exact Task", async () => {
    const calls: string[] = [];
    const playbook = {
      playbook: {
        projectId: "project-1",
        revision: 4,
        activePipelineName: "Delivery",
        milestones: [],
        savedPipelines: [],
        updatedAtEpochMs: 100,
      },
      stateRevision: 9,
    } satisfies PlaybookGetResult;
    const getPlaybook = vi.fn(async () => playbook);
    const setPosition = vi.fn(async (params) => {
      calls.push(`position:${params.taskId}:${params.passedMilestoneCount}`);
      return {
        ok: true as const,
        result: { taskId: params.taskId, passedMilestoneCount: params.passedMilestoneCount, stateRevision: 10 },
      };
    });
    const runNow = vi.fn(async (routineId: string, taskId: string) => {
      calls.push(`check:${routineId}:${taskId}`);
      return { accepted: true as const };
    });

    await expect(moveTaskToPlaybookStepAndCheck(
      "project-1",
      "task-1",
      3,
      "routine-review",
      { getPlaybook, setPosition, runNow },
    )).resolves.toBeUndefined();
    expect(setPosition).toHaveBeenCalledWith({
      projectId: "project-1",
      taskId: "task-1",
      passedMilestoneCount: 3,
      expectedPlaybookRevision: 4,
      expectedRevision: 9,
    });
    expect(calls).toEqual(["position:task-1:3", "check:routine-review:task-1"]);
  });

  it("keeps a successful Task move when the immediate check is refused", async () => {
    const getPlaybook = vi.fn(async () => ({
      playbook: {
        projectId: "project-1",
        revision: 4,
        activePipelineName: "Delivery",
        milestones: [],
        savedPipelines: [],
        updatedAtEpochMs: 100,
      },
      stateRevision: 9,
    } satisfies PlaybookGetResult));
    const setPosition = vi.fn(async () => ({
      ok: true as const,
      result: { taskId: "task-1", passedMilestoneCount: 2, stateRevision: 10 },
    }));
    const runNow = vi.fn(async () => { throw new Error("Worker is busy"); });

    await expect(moveTaskToPlaybookStepAndCheck(
      "project-1",
      "task-1",
      2,
      "routine-ci",
      { getPlaybook, setPosition, runNow },
    )).resolves.toBe("Task moved, but its immediate check could not start: Worker is busy");
    expect(setPosition).toHaveBeenCalledOnce();
    expect(runNow).toHaveBeenCalledWith("routine-ci", "task-1");
  });

  it("highlights the open assistant detail rather than an unrelated active terminal", () => {
    expect(assistantSelectionMatches({ kind: "steward" }, { kind: "steward", initialView: "terminal" })).toBe(true);
    expect(assistantSelectionMatches({ kind: "steward" }, { kind: "worker", workerId: "worker-1" })).toBe(false);
    expect(assistantSelectionMatches(
      { kind: "worker", workerId: "worker-1" },
      { kind: "worker", workerId: "worker-2" },
    )).toBe(false);
    expect(assistantSelectionMatches(
      { kind: "routine", routineId: "routine-1" },
      { kind: "routine", routineId: "routine-1", initialView: "context" },
    )).toBe(true);
  });

  it("creates sidebar routines with the bounded defaults and without enabling them", () => {
    expect(ROUTINE_CATALOG.map(({ kind }) => kind)).toEqual(["slack", "jira", "runtime", "delivery", "ciPr"]);
    expect(defaultRoutineParams("project-1", "worker-1", "slack", 3)).toEqual({
      projectId: "project-1",
      workerId: "worker-1",
      kind: "slack",
      triggerMode: "schedule",
      name: "Slack follow-ups",
      scheduleIntervalSeconds: 300,
      actionHandling: "off",
      expectedRevision: 3,
    });
    expect(defaultRoutineParams("project-1", "worker-1", "jira", 3).scheduleIntervalSeconds).toBe(900);
    expect(defaultRoutineParams("project-1", "worker-1", "runtime", 3).name).toBe("Runtime monitoring");
    expect(defaultRoutineParams("project-1", "worker-1", "delivery", 3).name).toBe("Delivery monitoring");
    expect(defaultRoutineParams("project-1", "worker-1", "ciPr", 3).name).toBe("CI & pull requests");
  });

  it("creates a named custom Routine instead of reusing a built-in type", () => {
    expect(customRoutineParams("project-1", "worker-1", "  Customer pulse  ", 45, 8)).toEqual({
      projectId: "project-1",
      workerId: "worker-1",
      kind: "custom",
      triggerMode: "schedule",
      name: "Customer pulse",
      scheduleIntervalSeconds: 2700,
      actionHandling: "off",
      expectedRevision: 8,
    });
  });

  it("opens the owning Worker terminal from a Checking Routine status", () => {
    const selected: string[] = [];
    const opened: unknown[] = [];
    const worker = {
      id: "worker-1",
      executorSessionId: "worker-session-1",
    } as WorkerConfigurationDto;

    expect(openCheckingWorkerTerminal(
      { label: "Checking", tone: "checking", reason: "Checking now.", nextAction: "Wait for the check." },
      worker,
      (sessionId) => selected.push(sessionId),
      (selection) => opened.push(selection),
    )).toBe(true);
    expect(selected).toEqual(["worker-session-1"]);
    expect(opened).toEqual([{ kind: "worker", workerId: "worker-1", initialView: "terminal" }]);
    expect(openCheckingWorkerTerminal(
      { label: "Checking", tone: "checking", reason: "Checking now.", nextAction: "Wait for the check." },
      { ...worker, executorSessionId: null },
      () => undefined,
      () => undefined,
    )).toBe(false);
    expect(openCheckingWorkerTerminal(
      { label: "Waiting", tone: "waiting", reason: "Waiting.", nextAction: "Wait for the next schedule." },
      worker,
      () => undefined,
      () => undefined,
    )).toBe(false);
  });

  it("keeps every created Routine visible and lets a virtual preset be dismissed", () => {
    const routine = (id: string, kind: RoutineConfigurationDto["kind"] = "slack") => ({
      id,
      workerId: "worker-1",
      kind,
      name: id,
      scheduleIntervalSeconds: 300,
    } as Parameters<typeof routineCatalogRows>[1][number]);
    expect(routineCatalogRows("worker-1", [routine("slack-1"), routine("slack-2"), routine("My custom check", "custom")], new Set())
      .map((row) => row.routine?.id ?? row.preset.kind))
      .toEqual(["slack-1", "slack-2", "jira", "runtime", "delivery", "ciPr", "My custom check"]);
    expect(routineCatalogRows(
      "worker-1",
      [],
      new Set([routinePresetKey("worker-1", "jira")]),
    ).map((row) => row.preset.kind)).toEqual(["slack", "runtime", "delivery", "ciPr"]);
  });

  it("keeps the pipeline's yes/no Routines out of the scheduled catalog", () => {
    const routine = (
      id: string,
      kind: RoutineConfigurationDto["kind"] = "ciPr",
      triggerMode: RoutineConfigurationDto["triggerMode"] = "schedule",
    ) => ({
      id, workerId: "worker-1", kind, triggerMode, name: id, scheduleIntervalSeconds: 300,
    } as Parameters<typeof routineCatalogRows>[1][number]);
    const all = [
      routine("Slack follow-ups", "slack"),
      routine("Is a PR open?", "ciPr", "onDemand"),
      routine("Is CI green?", "ciPr", "onDemand"),
      routine("Is it deployed?", "delivery", "onDemand"),
    ];
    // An on-demand Routine is a question on the board, so it never stands in
    // for the scheduled preset of its kind — the "CI & pull requests" suggestion
    // is still on offer.
    expect(routineCatalogRows("worker-1", all, new Set()).map((row) => row.routine?.id ?? row.preset.kind))
      .toEqual(["Slack follow-ups", "jira", "runtime", "delivery", "ciPr"]);
  });

  it("shows the Playbook cadence instead of the step Routine's padding interval", () => {
    const routine = {
      scheduleIntervalSeconds: 60, enabled: true, lastAttemptAtEpochMs: null,
    } as Parameters<typeof stepRoutineTimingLabel>[0];
    const asked = stepRoutineTimingLabel(routine, undefined, 2, undefined, 600);
    expect(asked).toContain("Step 3");
    // The Playbook owns the real recheck interval. The on-demand Routine's
    // required one-minute wire value is not presented as policy.
    expect(asked).toContain("every 10m while waiting");
    expect(asked).not.toContain("1m");
    expect(stepRoutineTimingLabel(routine, undefined, undefined)).toContain("No step uses this");
  });

  it("never calls a Routine unasked while a pipeline the Project kept still asks it", () => {
    const routine = {
      scheduleIntervalSeconds: 60, enabled: false, lastAttemptAtEpochMs: null,
    } as Parameters<typeof stepRoutineTimingLabel>[0];
    // The sidebar used to read only the active board, so a question parked in a
    // kept pipeline showed as "No step asks this" — while the daemon refused to
    // delete the Routine because that kept question still pointed at it.
    const kept = stepRoutineTimingLabel(routine, undefined, undefined, "Dev PR to production");
    expect(kept).toContain("kept Dev PR to production pipeline");
    expect(kept).not.toContain("No step uses this");
  });

  it("reads the step order from the active board and the holds from kept pipelines", () => {
    const index = stepRoutineIndex({
      milestones: [
        { routineId: "r-live", id: "m1", title: "Is CI green?", retryDelaySeconds: 300 },
        { routineId: "r-both", id: "m2", title: "Is a PR open?", retryDelaySeconds: 600 },
      ],
      savedPipelines: [
        { name: "Dev PR to production", milestones: [
          { routineId: "r-parked", id: "m3", title: "Is it deployed?", retryDelaySeconds: 1800 },
          { routineId: "r-both", id: "m4", title: "Is a PR open?", retryDelaySeconds: 3600 },
        ] },
        { name: "Older", milestones: [{ routineId: "r-parked", id: "m5", title: "Is it deployed?", retryDelaySeconds: 7200 }] },
      ],
    } as Parameters<typeof stepRoutineIndex>[0]);

    expect(index.activeRoutineIds).toEqual(["r-live", "r-both"]);
    // A Routine the board asks is never reported as merely kept, and a Routine
    // two kept pipelines ask is named by the first one that does.
    expect(index.keptPipelineByRoutine.get("r-both")).toBeUndefined();
    expect(index.keptPipelineByRoutine.get("r-parked")).toBe("Dev PR to production");
    expect(index.retryDelayByRoutine.get("r-live")).toBe(300);
    expect(index.retryDelayByRoutine.get("r-parked")).toBe(1800);
    expect(stepRoutineIndex(null).activeRoutineIds).toEqual([]);
  });

  it("draws one Project pipeline in board order and trails off-board checks", () => {
    const worker = (id: string) => ({ id } as WorkerConfigurationDto);
    const routine = (
      id: string,
      workerId: string,
      triggerMode: RoutineConfigurationDto["triggerMode"] = "onDemand",
    ) => ({ id, workerId, triggerMode, name: id } as RoutineConfigurationDto);
    const index = {
      activeRoutineIds: ["r-2", "r-1", "r-gone"],
      keptPipelineByRoutine: new Map([["r-kept", "Dev PR to production"]]),
      retryDelayByRoutine: new Map([["r-1", 600], ["r-2", 1800], ["r-kept", 300]]),
    };
    const board = playbookStepBoard(
      [worker("worker-1"), worker("worker-2")],
      [
        routine("r-1", "worker-1"),
        routine("r-2", "worker-2"),
        routine("r-kept", "worker-1"),
        routine("r-orphan", "worker-1"),
        routine("r-deleted-worker", "worker-3"),
        routine("scheduled", "worker-1", "schedule"),
      ],
      index,
    );
    // Board order wins over Worker grouping, and a step whose Routine is gone
    // renders nothing rather than a hole; the scheduled Routine stays in the
    // Worker's own catalog.
    expect(board.steps.map((node) => node.routine.id)).toEqual(["r-2", "r-1"]);
    expect(board.steps.map((node) => node.step)).toEqual([0, 1]);
    expect(board.steps.map((node) => node.worker?.id)).toEqual(["worker-2", "worker-1"]);
    expect(board.steps.map((node) => node.retryDelaySeconds)).toEqual([1800, 600]);
    expect(board.offBoard.map((node) => node.routine.id)).toEqual(["r-kept", "r-orphan"]);
    expect(board.offBoard.map((node) => node.keptPipeline)).toEqual(["Dev PR to production", undefined]);
    expect(board.offBoard.every((node) => node.step === undefined)).toBe(true);
    expect(stepRoutineCadence(600)).toBe("every 10m while waiting");
    expect(stepRoutineCadence(undefined)).toBe("runs when a Task is due");
  });

  it("names what leaves with a Worker before asking the one deletion question", () => {
    expect(workerDeletionQuestion(0)).toBe("Delete this Worker?");
    expect(workerDeletionQuestion(1)).toBe("Delete this Worker and its 1 Routine?");
    expect(workerDeletionQuestion(10)).toBe("Delete this Worker and its 10 Routines?");
  });

  it("shows interval plus last and next timing in the sidebar", () => {
    const routine = {
      scheduleIntervalSeconds: 300,
      enabled: true,
      lastAttemptAtEpochMs: 1_000,
    } as Parameters<typeof routineTimingLabel>[0];
    const label = routineTimingLabel(routine, {
      lastAttemptAtEpochMs: 2_000,
      nextDueAtEpochMs: 302_000,
    } as Parameters<typeof routineTimingLabel>[1]);
    expect(label).toContain("Every 5m");
    expect(label).toContain("last run");
    expect(label).toContain("next");
  });

  it("converts the visible Worker heartbeat setting without changing Routine timing", () => {
    expect(workerPingIntervalLabel(60)).toBe("Heartbeat · Every 1m");
    expect(workerPingIntervalLabel(3_600)).toBe("Heartbeat · Every 1h");
    expect(workerPingIntervalSeconds(15)).toBe(900);
  });
});

describe("A refused sidebar change says what the daemon said", () => {
  it("passes a rule the user can act on through, and hides one they cannot", () => {
    // A refusal that names the way out is the whole point of the message, so it
    // reaches the user unchanged.
    expect(assistantRefusalMessage(new Error("terminate its running Sessions before deleting the Project")))
      .toBe("terminate its running Sessions before deleting the Project");
    expect(assistantRefusalMessage(new Error("selected assistant CLI is unavailable")))
      .toBe("selected assistant CLI is unavailable");

    // A bare store rule names no way out, so repeating it at the user only
    // makes a working app look broken.
    expect(assistantRefusalMessage(new Error("store failed: constraint violation")))
      .toBe("The change didn't apply. Try again.");
    expect(assistantRefusalMessage(new Error(""))).toBe("The change didn't apply. Try again.");
  });
});

describe("First-run Build-with-agent CTA on the rail", () => {
  it("leads an empty board with the Builder", () => {
    expect(showPlaybookBuildCta(0, true, false)).toBe(true);
  });

  it("retires while the Builder runs and once steps exist", () => {
    expect(showPlaybookBuildCta(0, true, true)).toBe(false);
    expect(showPlaybookBuildCta(3, true, false)).toBe(false);
  });

  it("never renders without the wired improvement port", () => {
    expect(showPlaybookBuildCta(0, false, false)).toBe(false);
  });
});

describe("The locked Steward row before the Playbook exists", () => {
  it("hides the enable/agent controls while the Steward is off and the board is empty", () => {
    expect(stewardControlsLocked(false, 0)).toBe(true);
  });

  it("restores the controls once the pipeline exists", () => {
    expect(stewardControlsLocked(false, 1)).toBe(false);
    expect(stewardControlsLocked(false, 4)).toBe(false);
  });

  it("keeps the controls for an already-enabled Steward so it can be turned off", () => {
    expect(stewardControlsLocked(true, 0)).toBe(false);
  });
});

describe("Turn-on offer after the pipeline lands", () => {
  it("offers enabling the Steward right after this user's action created steps", () => {
    expect(stewardEnableOfferVisible(true, false, 3)).toBe(true);
  });

  it("waits until the created steps are actually on the board", () => {
    expect(stewardEnableOfferVisible(true, false, 0)).toBe(false);
  });

  it("never nags a Steward that is already on or a user who did not just create", () => {
    expect(stewardEnableOfferVisible(true, true, 3)).toBe(false);
    expect(stewardEnableOfferVisible(false, false, 3)).toBe(false);
  });
});

describe("Focusing the Builder terminal after Build pipeline with agent", () => {
  it("routes first creation through agent and model setup", () => {
    const setup = vi.fn();
    requestPlaybookBuilderSetup(setup);
    expect(setup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledWith({ surface: "playbook", ownerId: null });
  });

  it("focuses the Builder Session once launch intent and the Session are both present", () => {
    expect(playbookBuilderFocusSession(true, "session-9")).toBe("session-9");
  });

  it("waits while the launched Session has not reached the projection yet", () => {
    expect(playbookBuilderFocusSession(true, undefined)).toBeUndefined();
  });

  it("never steals focus without a live launch intent", () => {
    expect(playbookBuilderFocusSession(false, "session-9")).toBeUndefined();
  });
});
