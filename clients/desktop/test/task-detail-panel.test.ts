// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  TaskDetailPanel,
  pipelineProgressLabel,
  stepAnswerSource,
  stepEvidence,
  stepIsCheckable,
  stepTiming,
  taskPipelineView,
  type TaskPipelineStep,
} from "../src/renderer/ui/TaskDetailPanel.js";
import type {
  PlaybookDto, PlaybookMilestoneDto, PlaybookRuntimeResult, PlaybookRuntimeStepDto,
  PlaybookStepProgressDto, RoutineHealthDto,
} from "@termloop/contract/current";
import type { Task } from "../src/renderer/model.js";

const NOW = 1_700_000_000_000;

function milestone(overrides: Partial<PlaybookMilestoneDto> = {}): PlaybookMilestoneDto {
  return {
    id: "code-done",
    title: "Did the agent finish the code?",
    gate: "automatic",
    routineId: "routine-code",
    retryDelaySeconds: 600,
    completeWhen: "The Task branch has commits and no agent is still working.",
    whileWaiting: { mode: "off", instructions: "" },
    approver: null,
    ...overrides,
  };
}

function playbook(milestones: PlaybookMilestoneDto[]): PlaybookDto {
  return {
    projectId: "project-1",
    revision: 4,
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
    decidedAtEpochMs: NOW - 7_200_000,
    nextAttemptAtEpochMs: null,
    ...overrides,
  };
}

function runtimeStep(overrides: Partial<PlaybookRuntimeStepDto> = {}): PlaybookRuntimeStepDto {
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
  return { activePipelineName: "Dev PR to production", processingTaskId: null, steps, doneTaskIds, stateRevision: 12 };
}

function routineHealth(overrides: Partial<RoutineHealthDto> = {}): RoutineHealthDto {
  return {
    routineId: "routine-review",
    generation: 1,
    triggerMode: "onDemand",
    name: "Slack review request",
    contextMarkdown: "",
    contextRevision: 1,
    relatedTaskIds: ["task-1"],
    state: "idle",
    checkId: null,
    deadlineEpochMs: null,
    pingSent: false,
    pendingTrigger: false,
    attentionMessage: null,
    lastSuccessfulReportAtEpochMs: null,
    lastAttemptAtEpochMs: null,
    nextDueAtEpochMs: null,
    ...overrides,
  };
}

const ROUTINES = [
  { id: "routine-code", name: "Code finished", enabled: true },
  { id: "routine-review", name: "Slack review request", enabled: true },
  { id: "routine-deploy", name: "Deployment watch", enabled: false },
];

const THREE_STEPS = [
  milestone(),
  milestone({ id: "review-requested", title: "Was Nurguyl asked on Slack to review the PR?", routineId: "routine-review" }),
  milestone({ id: "deployed", title: "Did the master PR deploy?", routineId: "routine-deploy" }),
];

function standingRuntime(processingTaskId: string | null = null): PlaybookRuntimeResult {
  return {
    ...runtime([
      runtimeStep({ progress: [progress()] }),
      runtimeStep({
        milestoneId: "review-requested",
        routineId: "routine-review",
        waitingTaskIds: ["task-1"],
        progress: [progress({
          verdict: "waiting",
          evidence: "No review request seen in the channel.",
          decidedAtEpochMs: NOW - 600_000,
          nextAttemptAtEpochMs: NOW + 720_000,
        })],
        nextAttemptAtEpochMs: NOW + 720_000,
      }),
      runtimeStep({ milestoneId: "deployed", routineId: "routine-deploy" }),
    ]),
    processingTaskId,
  };
}

describe("a Task's place on the pipeline", () => {
  it("stands the Task at the question core says it waits on, clearing everything behind it", () => {
    const view = taskPipelineView(
      playbook(THREE_STEPS),
      runtime([
        runtimeStep({ progress: [progress()] }),
        runtimeStep({
          milestoneId: "review-requested",
          routineId: "routine-review",
          waitingTaskIds: ["task-1"],
          progress: [progress({ verdict: "waiting", evidence: "No review request seen in the channel.", decidedAtEpochMs: NOW - 600_000, nextAttemptAtEpochMs: NOW + 720_000 })],
          nextAttemptAtEpochMs: NOW + 720_000,
        }),
        runtimeStep({ milestoneId: "deployed", routineId: "routine-deploy" }),
      ]),
      ROUTINES,
      "task-1",
    );

    expect(view?.steps.map((step) => step.standing)).toEqual(["passed", "waiting", "ahead"]);
    expect(view?.placement).toBe("waiting");
    expect(view?.standingAt).toBe(2);
    expect(view?.passedCount).toBe(1);
    expect(pipelineProgressLabel(view!)).toBe("Step 2 of 3");
  });

  it("keeps each Task's own answers apart when several wait at one question", () => {
    const view = taskPipelineView(
      playbook(THREE_STEPS),
      runtime([
        runtimeStep({
          waitingTaskIds: ["task-2", "task-1"],
          progress: [
            progress({ taskId: "task-2", verdict: "waiting", evidence: "Task 2 has no commits.", nextAttemptAtEpochMs: NOW + 60_000 }),
            progress({ taskId: "task-1", verdict: "waiting", evidence: "Task 1 still has an agent working.", nextAttemptAtEpochMs: NOW + 300_000 }),
          ],
        }),
        runtimeStep({ milestoneId: "review-requested", routineId: "routine-review" }),
        runtimeStep({ milestoneId: "deployed", routineId: "routine-deploy" }),
      ]),
      ROUTINES,
      "task-1",
    );

    expect(stepEvidence(view!.steps[0]!)).toBe("Task 1 still has an agent working.");
    expect(stepTiming(view!.steps[0]!, NOW)).toBe("next check in 5m");
  });

  it("marks a Task core lists as done as having cleared every question", () => {
    const view = taskPipelineView(
      playbook(THREE_STEPS),
      runtime(
        THREE_STEPS.map((entry) => runtimeStep({
          milestoneId: entry.id,
          routineId: entry.routineId,
          progress: [progress()],
        })),
        ["task-1"],
      ),
      ROUTINES,
      "task-1",
    );

    expect(view?.placement).toBe("done");
    expect(view?.steps.every((step) => step.standing === "passed")).toBe(true);
    expect(pipelineProgressLabel(view!)).toBe("Cleared all 3");
  });

  it("leaves a Task the pipeline no longer walks with only its recorded answers", () => {
    const view = taskPipelineView(
      playbook(THREE_STEPS),
      runtime([
        runtimeStep({ progress: [progress()] }),
        runtimeStep({ milestoneId: "review-requested", routineId: "routine-review" }),
        runtimeStep({ milestoneId: "deployed", routineId: "routine-deploy" }),
      ]),
      ROUTINES,
      "task-1",
    );

    expect(view?.placement).toBe("away");
    expect(view?.standingAt).toBeUndefined();
    expect(view?.steps.map((step) => step.standing)).toEqual(["passed", "ahead", "ahead"]);
    expect(pipelineProgressLabel(view!)).toBe("1 of 3 cleared");
  });

  it("draws no ladder at all when the Project is not walking a pipeline", () => {
    expect(taskPipelineView(null, null, ROUTINES, "task-1")).toBeUndefined();
    expect(taskPipelineView(playbook([]), null, ROUTINES, "task-1")).toBeUndefined();
  });

  it("stands a Task at the first question before any Routine has ever answered", () => {
    const view = taskPipelineView(
      playbook(THREE_STEPS),
      runtime([
        runtimeStep({ waitingTaskIds: ["task-1"] }),
        runtimeStep({ milestoneId: "review-requested", routineId: "routine-review" }),
        runtimeStep({ milestoneId: "deployed", routineId: "routine-deploy" }),
      ]),
      ROUTINES,
      "task-1",
    );

    expect(view?.standingAt).toBe(1);
    expect(stepEvidence(view!.steps[0]!)).toBe("No completion result recorded for this Task yet.");
    expect(stepTiming(view!.steps[0]!, NOW)).toBe("checking next");
  });
});

describe("what a step tells the reader", () => {
  function step(overrides: Partial<TaskPipelineStep> = {}): TaskPipelineStep {
    return {
      position: 2,
      milestone: milestone(),
      standing: "waiting",
      progress: progress({ verdict: "waiting", nextAttemptAtEpochMs: NOW + 1_800_000 }),
      routine: { name: "Code finished", enabled: true },
      ...overrides,
    };
  }

  it("looks backwards on a cleared question and forwards on the standing one", () => {
    expect(stepTiming(step({ standing: "passed", progress: progress() }), NOW)).toBe("cleared 2h ago");
    expect(stepTiming(step(), NOW)).toBe("next check in 30m");
    expect(stepTiming(step({ standing: "ahead", progress: undefined }), NOW)).toBeUndefined();
  });

  it("says a check is imminent rather than counting down past zero", () => {
    expect(stepTiming(step({ progress: progress({ verdict: "waiting", nextAttemptAtEpochMs: NOW - 1 }) }), NOW))
      .toBe("checking next");
  });

  it("names who answers the question, and says so when nobody can", () => {
    expect(stepAnswerSource(step())).toEqual({ text: "Code finished", blocked: false });
    expect(stepAnswerSource(step({ routine: { name: "Deployment watch", enabled: false } })))
      .toEqual({ text: "Deployment watch is off", blocked: true });
    expect(stepAnswerSource(step({ routine: undefined })))
      .toEqual({ text: "No completion Routine", blocked: true });
    expect(stepAnswerSource(step({ milestone: milestone({ gate: "human", approver: "ferit" }) })))
      .toEqual({ text: "ferit approves this", blocked: false });
    expect(stepAnswerSource(step({ milestone: milestone({ gate: "human", approver: null }) })))
      .toEqual({ text: "No approver named", blocked: true });
  });

  it("offers a manual check only where one would actually run", () => {
    expect(stepIsCheckable(step())).toBe(true);
    expect(stepIsCheckable(step({ standing: "passed" }))).toBe(false);
    expect(stepIsCheckable(step({ standing: "ahead" }))).toBe(false);
    expect(stepIsCheckable(step({ routine: { name: "Deployment watch", enabled: false } }))).toBe(false);
    // A human gate waits on a person; there is nothing for TermLoop to run.
    expect(stepIsCheckable(step({ milestone: milestone({ gate: "human", approver: "ferit" }) }))).toBe(false);
  });

  it("keeps a cleared question silent when no evidence was recorded", () => {
    expect(stepEvidence(step({ standing: "passed", progress: undefined }))).toBeUndefined();
    expect(stepEvidence(step({ standing: "ahead", progress: undefined }))).toBeUndefined();
  });
});

describe("the Task detail page on screen", () => {
  function health(
    overrides: Partial<NonNullable<Task["worktree_health"]>> = {},
  ): NonNullable<Task["worktree_health"]> {
    return {
      observation_sequence: 1,
      observed_at_epoch_ms: NOW,
      path_state: "present",
      registration_state: "matching",
      head_state: "matching",
      launch_ready: true,
      checked_out_branch: "task/pipeline-page",
      change_count: 0,
      tracked_state: "clean",
      staged_state: "clean",
      untracked_state: "absent",
      ignored_state: "absent",
      submodule_state: "absent",
      worktree_lock_state: "absent",
      index_lock_state: "absent",
      upstream_state: "inSync",
      summary: "healthy",
      ...overrides,
    };
  }

  function detailTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-1",
      project_id: "project-1",
      title: "Ship the pipeline page",
      brief: null,
      jira_url: null,
      status: "open",
      archived_at_epoch_ms: null,
      branch: { repository_root: "/repository", name: "task/pipeline-page" },
      worktree: { path: "/worktrees/pipeline-page" },
      rank: 1,
      created_at_epoch_ms: NOW,
      updated_at_epoch_ms: NOW,
      ...overrides,
    } as Task;
  }

  function panelProps(overrides: Record<string, unknown> = {}) {
    return {
      task: detailTask(),
      refreshToken: 0,
      sessions: [],
      statusesById: new Map(),
      reviewReadySessionIds: new Set<string>(),
      gitHostProjection: undefined,
      branchCommitSummary: undefined,
      nowEpochMs: NOW,
      close: () => {},
      selectSession: () => {},
      openChanges: () => {},
      openExternal: async () => {},
      openPlaybook: () => {},
      getPlaybook: async () => ({ playbook: playbook(THREE_STEPS), stateRevision: 12 }),
      getPlaybookRuntime: async () => standingRuntime(),
      setPlaybookTaskPosition: async (params: { taskId: string; passedMilestoneCount: number }) => ({
        ok: true,
        result: {
          taskId: params.taskId,
          passedMilestoneCount: params.passedMilestoneCount,
          stateRevision: 13,
        },
      }),
      listRoutines: async () => ({
        configurations: ROUTINES.map((routine) => ({
          ...routine,
          projectId: "project-1",
          kind: "custom",
          triggerMode: "onDemand",
          prompt: "",
          scheduleIntervalSeconds: 0,
          generation: 1,
          contextMarkdown: "",
          contextRevision: 1,
          recentSourceKeys: [],
          relatedTaskIds: [],
          lastCheckStartedAtEpochMs: null,
          lastSuccessfulReportAtEpochMs: null,
          lastAttemptAtEpochMs: null,
          updatedAtEpochMs: NOW,
        })),
        stateRevision: 12,
      }),
      listRoutineRuntime: async () => ({
        health: [], reports: [], reportsTruncated: false, stateRevision: 12,
      }),
      runRoutineNow: async () => ({ ok: true }),
      ...overrides,
    } as never;
  }

  async function mount(overrides: Record<string, unknown> = {}) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(TaskDetailPanel, panelProps(overrides))));
    return {
      container,
      async unmount() {
        await act(async () => root.unmount());
        container.remove();
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      },
    };
  }

  it("grades the ladder so the standing question is the only open card", async () => {
    const { container, unmount } = await mount();

    const steps = [...container.querySelectorAll(".td-step")];
    expect(steps.map((step) => step.className)).toEqual([
      "td-step passed",
      "td-step waiting",
      "td-step ahead",
      // The destination is the last station on the same spine, still ahead.
      "td-step terminus ahead",
    ]);
    expect(container.querySelector(".td-step.waiting")?.getAttribute("aria-current")).toBe("step");
    expect(container.querySelector(".td-progress")?.textContent)
      .toBe("Dev PR to production · Step 2 of 3");
    expect(container.querySelector(".td-step.waiting .td-evidence")?.textContent)
      .toBe("No review request seen in the channel.");
    expect(container.querySelector(".td-step.waiting .td-timing")?.textContent)
      .toBe("next check in 12m");

    await unmount();
  });

  it("heads the page with the sidebar's own meta line and no status pill while open", async () => {
    const { container, unmount } = await mount();

    expect(container.querySelector(".td-chip")).toBeNull();
    expect(container.querySelector(".td-header .task-meta-branch")?.textContent).toBe("task/pipeline-page");
    expect(container.querySelector(".td-status")).toBeNull();
    // The fixture's checkout is still being observed, so that is the one thing
    // "Now" says; a healthy Task prints no reassurance line here at all.
    expect(container.querySelectorAll(".td-now-item")).toHaveLength(1);
    expect(container.textContent).not.toContain("Ready to run agents");
    // Sections in order of use, one column.
    expect([...container.querySelectorAll(".td-body > .td-block > h2, .td-body > .td-block .td-block-head h2")].map((h) => h.textContent))
      .toEqual(["Now", "Sessions", "Changes", "Pipeline"]);
    expect(container.querySelector(".td-side")).toBeNull();

    await unmount();
  });

  it("keeps a long description inside the detail page's scroll surface", async () => {
    const task = detailTask({ brief: Array.from({ length: 80 }, (_, index) => `Description line ${index + 1}`).join("\n") });
    const { container, unmount } = await mount({ task });

    const body = container.querySelector(".td-body")!;
    const brief = container.querySelector(".td-brief")!;
    expect(container.querySelector(".td-header .td-brief")).toBeNull();
    expect(brief.parentElement).toBe(body);
    expect(brief.compareDocumentPosition(container.querySelector('[aria-label="Sessions"]')!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await unmount();
  });

  it("shows the checked-out worktree branch as the effective branch", async () => {
    const task = detailTask({
      worktree_health: health({ checked_out_branch: "feature/live-checkout", head_state: "mismatch" }),
    });
    const { container, unmount } = await mount({ task });

    expect(container.querySelector(".td-effective-branch")?.textContent)
      .toBe("feature/live-checkout");
    expect(container.querySelector(".td-effective-branch")?.classList.contains("attention"))
      .toBe(true);
    expect(container.querySelector(".td-effective-branch")?.getAttribute("title"))
      .toContain("Task branch task/pipeline-page");

    await unmount();
  });

  it("shows every observed Task-worktree branch with its named base and opens that branch", async () => {
    const opened: unknown[] = [];
    const task = detailTask({
      branches: {
        primary_branch_id: "primary",
        checked_out_branch_id: "branch-2",
        evidence_truncated: false,
        items: [
          {
            branch_id: "primary",
            name: "task/pipeline-page",
            role: "primary",
            held_by_task_id: null,
            checked_out: false,
            base_ref: "develop",
            base_oid: "a".repeat(40),
            base_evidence: "provisioned",
            first_observed_worktree_generation: 1,
            rollup_eligible: true,
          },
          {
            branch_id: "branch-2",
            name: "feature/api",
            role: "associated",
            held_by_task_id: null,
            checked_out: true,
            base_ref: "task/pipeline-page",
            base_oid: "b".repeat(40),
            base_evidence: "branchCreationReflog",
            first_observed_worktree_generation: 1,
            rollup_eligible: true,
          },
          {
            branch_id: "branch-3",
            name: "feature/legacy-checkout",
            role: "associated",
            held_by_task_id: null,
            checked_out: false,
            base_ref: null,
            base_oid: "c".repeat(40),
            base_evidence: "worktreeReflog",
            first_observed_worktree_generation: 1,
            rollup_eligible: true,
          },
        ],
      },
    });
    const { container, unmount } = await mount({
      task,
      openChanges: (source: unknown) => opened.push(source),
    });

    const branch = [...container.querySelectorAll<HTMLButtonElement>(".td-fact-action")]
      .find((button) => button.textContent?.includes("feature/api · base task/pipeline-page"));
    expect(branch).toBeDefined();
    const branchWithoutNamedBase = [...container.querySelectorAll<HTMLButtonElement>(".td-fact-action")]
      .find((button) => button.textContent?.includes("feature/legacy-checkout"));
    expect(branchWithoutNamedBase?.textContent).toBe("feature/legacy-checkout");
    expect(container.textContent).not.toContain("cccccccccccc");
    await act(async () => branch!.click());
    expect(opened).toEqual([{ kind: "commits", branchId: "branch-2" }]);

    await unmount();
  });

  it("measures how much of the ladder is already behind the Task", async () => {
    const { container, unmount } = await mount();

    // Standing at step 2 of 3 means exactly one question is answered.
    expect(container.querySelector<HTMLElement>(".td-meter i")?.style.width).toBe("33%");

    await unmount();
  });

  it("names who answers each question, and warns where nobody can", async () => {
    const { container, unmount } = await mount();

    expect(container.querySelector(".td-step.waiting .td-answers")?.textContent)
      .toBe("Checked by Slack review request");
    // A stage still ahead names its judge too, because a Routine that is
    // switched off will never move this Task and that is worth knowing early.
    const ahead = container.querySelector(".td-step.ahead .td-answers");
    expect(ahead?.textContent).toBe("Deployment watch is off");
    expect(ahead?.className).toContain("blocked");

    await unmount();
  });

  it("keeps a cleared question's recorded answer one hover away", async () => {
    const { container, unmount } = await mount();

    // The sentence itself is the evidence; it is never handed to a tooltip.
    // A cleared rung is one line; its whole recorded answer rides on the row
    // tooltip rather than spending a paragraph on a settled question.
    expect(container.querySelector(".td-step.passed .td-evidence")).toBeNull();
    expect(container.querySelector(".td-step.passed")?.getAttribute("title"))
      .toBe("Branch has 3 commits and no agent is working.");

    await unmount();
  });

  it("runs the standing step's Routine on demand and reloads what it answered", async () => {
    const asked: Array<[string, string | undefined]> = [];
    let evidence = "No review request seen in the channel.";
    const { container, unmount } = await mount({
      runRoutineNow: async (routineId: string, taskId?: string) => {
        asked.push([routineId, taskId]);
        evidence = "Asked Nurguyl to review the dev pull request.";
        return { ok: true };
      },
      getPlaybookRuntime: async () => runtime([
        runtimeStep({ progress: [progress()] }),
        runtimeStep({
          milestoneId: "review-requested",
          routineId: "routine-review",
          waitingTaskIds: ["task-1"],
          progress: [progress({ verdict: "waiting", evidence, nextAttemptAtEpochMs: NOW + 720_000 })],
          nextAttemptAtEpochMs: NOW + 720_000,
        }),
        runtimeStep({ milestoneId: "deployed", routineId: "routine-deploy" }),
      ]),
    });

    await act(async () => container.querySelector<HTMLButtonElement>(".td-check-now")!.click());

    expect(asked).toEqual([["routine-review", "task-1"]]);
    expect(container.querySelector(".td-step.waiting .td-evidence")?.textContent)
      .toBe("Asked Nurguyl to review the dev pull request.");

    await unmount();
  });

  it("shows an externally claimed standing Routine as checking", async () => {
    const { container, unmount } = await mount({
      getPlaybookRuntime: async () => standingRuntime("task-1"),
      listRoutineRuntime: async () => ({
        health: [routineHealth({ state: "checking", checkId: "check-1" })],
        reports: [],
        reportsTruncated: false,
        stateRevision: 13,
      }),
    });

    const button = container.querySelector<HTMLButtonElement>(".td-check-now")!;
    expect(button.textContent).toBe("Checking…");
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Slack review request is checking this step now");

    await unmount();
  });

  it("sets the Task to any question and can reset it to the start", async () => {
    const requested: number[] = [];
    let passedCount = 1;
    let stateRevision = 12;
    const positionedRuntime = () => runtime(THREE_STEPS.map((entry, index) => runtimeStep({
      milestoneId: entry.id,
      routineId: entry.routineId,
      waitingTaskIds: index === passedCount && passedCount < THREE_STEPS.length ? ["task-1"] : [],
      progress: index < passedCount ? [progress()] : [],
    })), passedCount === THREE_STEPS.length ? ["task-1"] : []);
    const { container, unmount } = await mount({
      getPlaybook: async () => ({ playbook: playbook(THREE_STEPS), stateRevision }),
      getPlaybookRuntime: async () => ({ ...positionedRuntime(), stateRevision }),
      listRoutines: async () => ({ configurations: [], stateRevision }),
      setPlaybookTaskPosition: async (params: { taskId: string; passedMilestoneCount: number }) => {
        requested.push(params.passedMilestoneCount);
        passedCount = params.passedMilestoneCount;
        stateRevision += 1;
        return {
          ok: true as const,
          result: {
            taskId: params.taskId,
            passedMilestoneCount: params.passedMilestoneCount,
            stateRevision,
          },
        };
      },
    });

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[aria-label="Set Task at delivery pipeline step 3"]',
    )!.click());
    expect(requested).toEqual([2]);
    expect(container.querySelector(".td-progress")?.textContent)
      .toBe("Dev PR to production · Step 3 of 3");

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[aria-label="Set Task at delivery pipeline step 1"]',
    )!.click());
    expect(requested).toEqual([2, 0]);
    expect(container.querySelector(".td-progress")?.textContent)
      .toBe("Dev PR to production · Step 1 of 3");

    await unmount();
  });

  it("says the daemon's own refusal instead of failing silently", async () => {
    const { container, unmount } = await mount({
      runRoutineNow: async () => { throw new Error("no Task is waiting at this pipeline step right now"); },
    });

    await act(async () => container.querySelector<HTMLButtonElement>(".td-check-now")!.click());

    expect(container.querySelector(".ap-error")?.textContent)
      .toBe("no Task is waiting at this pipeline step right now");

    await unmount();
  });

  it("offers to build a pipeline when the Project has none", async () => {
    let opened = 0;
    const { container, unmount } = await mount({
      getPlaybook: async () => ({ playbook: null, stateRevision: 12 }),
      openPlaybook: () => { opened += 1; },
    });

    expect(container.querySelector(".td-spine")).toBeNull();
    expect(container.querySelector(".td-empty")?.textContent)
      .toContain("no delivery pipeline yet");
    await act(async () => container.querySelector<HTMLButtonElement>(".td-open-playbook")!.click());
    expect(opened).toBe(1);

    await unmount();
  });

  it("explains why a closed Task has left the pipeline", async () => {
    const { container, unmount } = await mount({
      task: detailTask({ status: "closed" }),
      getPlaybookRuntime: async () => runtime([
        runtimeStep({ progress: [progress()] }),
        runtimeStep({ milestoneId: "review-requested", routineId: "routine-review" }),
        runtimeStep({ milestoneId: "deployed", routineId: "routine-deploy" }),
      ]),
    });

    expect(container.querySelector(".td-status")?.textContent).toBe("Closed");
    expect(container.querySelector(".td-pipeline .td-note")?.textContent).toContain("closed");
    expect(container.querySelector(".td-check-now")).toBeNull();
    expect(container.querySelector(".td-progress")?.textContent)
      .toBe("Dev PR to production · 1 of 3 cleared");

    await unmount();
  });
});

describe("the pipeline's destination", () => {
  it("lights the destination only once every question is answered", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const doneRuntime = async () => runtime(
      THREE_STEPS.map((entry) => runtimeStep({
        milestoneId: entry.id,
        routineId: entry.routineId,
        progress: [progress()],
      })),
      ["task-1"],
    );
    await act(async () => root.render(createElement(TaskDetailPanel, {
      task: {
        id: "task-1", project_id: "project-1", title: "Ship it", brief: null, jira_url: null,
        status: "open", archived_at_epoch_ms: null,
        branch: { repository_root: "/repository", name: "task/ship" }, worktree: null,
        rank: 1, created_at_epoch_ms: NOW, updated_at_epoch_ms: NOW,
      },
      refreshToken: 0, sessions: [], statusesById: new Map(), reviewReadySessionIds: new Set(),
      gitHostProjection: undefined, branchCommitSummary: undefined, nowEpochMs: NOW,
      close: () => {}, selectSession: () => {}, openChanges: () => {}, openExternal: async () => {},
      openPlaybook: () => {},
      getPlaybook: async () => ({ playbook: playbook(THREE_STEPS), stateRevision: 12 }),
      getPlaybookRuntime: doneRuntime,
      listRoutines: async () => ({ configurations: [], stateRevision: 12 }),
      listRoutineRuntime: async () => ({
        health: [], reports: [], reportsTruncated: false, stateRevision: 12,
      }),
      runRoutineNow: async () => ({ ok: true }),
    } as never)));

    const terminus = container.querySelector(".td-step.terminus")!;
    expect(terminus.className).toBe("td-step terminus passed");
    expect(terminus.querySelector(".td-terminus")?.textContent)
      .toBe("Done — every stage completed");
    expect(terminus.querySelector<HTMLButtonElement>(".td-set-position")?.disabled).toBe(true);
    expect(container.querySelector(".td-check-now")).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});

describe("what makes the page read the daemon again", () => {
  it("reloads on a playbook invalidation, not on every parent render", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let reads = 0;

    // Rebuilt on every render, exactly as the composition layer rebuilds them.
    const render = async (refreshToken: number) => act(async () => root.render(createElement(TaskDetailPanel, {
      task: {
        id: "task-1", project_id: "project-1", title: "Ship it", brief: null, jira_url: null,
        status: "open", archived_at_epoch_ms: null,
        branch: { repository_root: "/repository", name: "task/ship" }, worktree: null,
        rank: 1, created_at_epoch_ms: NOW, updated_at_epoch_ms: NOW,
      },
      refreshToken, sessions: [], statusesById: new Map(), reviewReadySessionIds: new Set(),
      gitHostProjection: undefined, branchCommitSummary: undefined, nowEpochMs: NOW,
      close: () => {}, selectSession: () => {}, openChanges: () => {}, openExternal: async () => {},
      openPlaybook: () => {},
      getPlaybook: async () => { reads += 1; return { playbook: playbook(THREE_STEPS), stateRevision: 12 }; },
      getPlaybookRuntime: async () => runtime([]),
      listRoutines: async () => ({ configurations: [], stateRevision: 12 }),
      listRoutineRuntime: async () => ({
        health: [], reports: [], reportsTruncated: false, stateRevision: 12,
      }),
      runRoutineNow: async () => ({ ok: true }),
    } as never)));

    await render(0);
    expect(reads).toBe(1);
    await render(0);
    await render(0);
    expect(reads).toBe(1);
    await render(1);
    expect(reads).toBe(2);

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
