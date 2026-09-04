import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  assistantTabs,
  assistantTerminalSessionId,
  capabilityCopy,
  capabilityMark,
  companionSupervisorCopy,
  mergeCompanionMessages,
  pendingCompanionProposalId,
  actionableCompanionSuggestionId,
  stewardReplyAvailabilityCopy,
  stewardPanelIdentity,
  routineProblemRecoveryCopy,
  routineInstructionsUpdateParams,
  routineStewardInstructionsUpdateParams,
  routineActionHandlingUpdateParams,
  retireStepRoutine,
  assistantInstructionsEditableSuffix,
  playbookRoutineCompletionEvidence,
  playbookRoutineRetryDelaySeconds,
  workerHeartbeatUpdateParams,
  workerInstructionsUpdateParams,
  upsertRoutineConfiguration,
  routineTimeCopy,
  playbookPipelineWorkerId,
  isRevisionConflict,
  withCurrentRevision,
  assistantRefusalMessage,
  playbookOnboardingCta,
  RoutineContextEditor,
  StewardSystemPromptCard,
} from "../src/renderer/ui/StewardPanel.js";
import type { AssistantPromptContextDto, CompanionMessageDto, PlaybookDto, RoutineConfigurationDto, WorkerConfigurationDto } from "@termloop/contract/current";
import { promptImprovementActionLabel } from "../src/renderer/ui/PromptImprovement.js";

describe("Steward capability presentation", () => {
  it("names each assistant improver by the scope it changes", () => {
    expect(promptImprovementActionLabel("playbook")).toBe("Edit pipeline with agent");
    expect(promptImprovementActionLabel("routineBuilder")).toBe("Add Routine with agent");
    expect(promptImprovementActionLabel("routineInstructions")).toBe("Improve this Routine");
    expect(promptImprovementActionLabel("stewardInstructions")).toBe("Improve Steward defaults");
    expect(promptImprovementActionLabel("workerInstructions")).toBe("Improve Worker defaults");
  });

  it("binds terminal views only to the exact Steward or Worker Session", () => {
    const steward = { projectId: "project-1", agentId: "codex", model: "gpt-5.6-sol", permission: "bypassPermissions", reasoning: "high", enabled: true, systemPrompt: "PM", executorSessionId: "steward-session", generation: 1, updatedAtEpochMs: 1 } as const;
    const workers = [{ id: "worker-1", projectId: "project-1", name: "Worker 1", agentId: "claude", model: "sonnet", permission: "default", reasoning: "medium", enabled: true, pingIntervalSeconds: 60, workerPrompt: "Handle Routines", systemPrompt: "Be concise", executorSessionId: "worker-session", generation: 1, updatedAtEpochMs: 1 }] as const;
    expect(assistantTerminalSessionId({ kind: "steward" }, steward, workers)).toBe("steward-session");
    expect(assistantTerminalSessionId({ kind: "worker", workerId: "worker-1" }, steward, workers)).toBe("worker-session");
    expect(assistantTerminalSessionId({ kind: "worker", workerId: "missing" }, steward, workers)).toBeNull();
    expect(assistantTerminalSessionId({ kind: "routine", routineId: "routine-1" }, steward, workers)).toBeNull();
  });

  it("shows one complete Config surface for each persistent assistant", () => {
    expect(assistantTabs("worker")).toEqual([
      ["terminal", "Terminal"],
      ["configuration", "Config"],
    ]);
    expect(assistantTabs("steward")).toEqual([
      ["chat", "Workspace"],
      ["configuration", "Config"],
    ]);
    expect(assistantTabs("steward", true)).toEqual([
      ["chat", "Workspace"],
      ["builder", "Builder"],
      ["configuration", "Config"],
    ]);
    expect(assistantTabs("routine").map(([id]) => id)).toEqual(["context"]);
  });

  it("collapses the Steward panel to the Builder alone before the Playbook exists", () => {
    expect(assistantTabs("steward", true, true)).toEqual([["builder", "Builder"]]);
    expect(assistantTabs("steward", false, true)).toEqual([]);
    // The lock is the Steward's alone; a Worker panel keeps its surfaces.
    expect(assistantTabs("worker", false, true)).toEqual([
      ["terminal", "Terminal"],
      ["configuration", "Config"],
    ]);
  });

  it("consolidates Worker instructions into the single editable document", () => {
    const worker = {
      id: "worker-1", projectId: "project-1", name: "Worker 1", agentId: "codex",
      model: "gpt-5.6-sol", permission: "bypassPermissions", reasoning: "high",
      enabled: true, pingIntervalSeconds: 300, workerPrompt: "Old worker",
      systemPrompt: "Old system", executorSessionId: "session-1", generation: 2,
      updatedAtEpochMs: 1,
    } satisfies WorkerConfigurationDto;
    expect(workerInstructionsUpdateParams(worker, "Complete Worker instructions", 12)).toEqual({
      workerId: "worker-1", name: "Worker 1", agentId: "codex", enabled: true,
      model: "gpt-5.6-sol", permission: "bypassPermissions", reasoning: "high",
      pingIntervalSeconds: 300, workerPrompt: "", systemPrompt: "Complete Worker instructions",
      expectedRevision: 12,
    });
  });

  it("updates Worker heartbeat without changing launch or instruction settings", () => {
    const worker = {
      id: "worker-1", projectId: "project-1", name: "Worker 1", agentId: "codex",
      model: "gpt-5.6-luna", permission: "bypassPermissions", reasoning: "medium",
      enabled: true, pingIntervalSeconds: 60, workerPrompt: "Handle Routines",
      systemPrompt: "Be concise", executorSessionId: "session-1", generation: 2,
      updatedAtEpochMs: 1,
    } satisfies WorkerConfigurationDto;
    expect(workerHeartbeatUpdateParams(worker, 900, 12)).toEqual({
      workerId: "worker-1", name: "Worker 1", agentId: "codex", enabled: true,
      model: "gpt-5.6-luna", permission: "bypassPermissions", reasoning: "medium",
      pingIntervalSeconds: 900, workerPrompt: "Handle Routines", systemPrompt: "Be concise",
      expectedRevision: 12,
    });
  });

  it("reads Playbook policy for active and kept step Routines", () => {
    const configured = {
      milestones: [{ routineId: "active", retryDelaySeconds: 300, completeWhen: "Active evidence" }],
      savedPipelines: [{ name: "Kept", milestones: [{ routineId: "kept", retryDelaySeconds: 1800, completeWhen: "Kept evidence" }] }],
    } as Parameters<typeof playbookRoutineRetryDelaySeconds>[0];
    expect(playbookRoutineRetryDelaySeconds(configured, "active")).toBe(300);
    expect(playbookRoutineRetryDelaySeconds(configured, "kept")).toBe(1800);
    expect(playbookRoutineRetryDelaySeconds(configured, "missing")).toBeUndefined();
    expect(playbookRoutineCompletionEvidence(configured, "active")).toBe("Active evidence");
    expect(playbookRoutineCompletionEvidence(configured, "kept")).toBe("Kept evidence");
    expect(playbookRoutineCompletionEvidence(configured, "missing")).toBeUndefined();
  });

  it("edits each complete assistant instruction document through one editor", () => {
    const runtime = "Required Steward runtime";
    expect(assistantInstructionsEditableSuffix(`${runtime}\n\nPrefer concise updates.`, runtime))
      .toBe("Prefer concise updates.");
    expect(assistantInstructionsEditableSuffix(runtime, runtime)).toBe("");
    expect(assistantInstructionsEditableSuffix("Changed required runtime", runtime)).toBeUndefined();
  });

  it("edits only Project instructions and links to protected TermLoop instructions", () => {
    const context = {
      initialPrompt: "Activation",
      protectedPrompt: "Required Steward runtime",
      instructionsPrompt: "Required Steward runtime\n\nPrefer concise updates.",
      instructionDelivery: "codexDeveloperInstructions",
      wakePrompt: "Wake",
    } satisfies AssistantPromptContextDto;
    const markup = renderToStaticMarkup(createElement(StewardSystemPromptCard, {
      context,
      busy: false,
      setupImprovement: () => undefined,
      openTermLoopInstructions: () => undefined,
      save: async () => undefined,
      reload: async () => undefined,
    }));
    expect(markup).toContain("Your Steward instructions");
    expect(markup).toContain("Prefer concise updates.");
    expect(markup).not.toContain("Required Steward runtime");
    expect(markup).toContain("TermLoop instructions");
  });

  it("explains a Routine as Worker observation, completion, Steward response, and permission", () => {
    const routine = {
      id: "routine-1", projectId: "project-1", workerId: "worker-1",
      triggerMode: "onDemand", name: "Release verified", instructions: "Inspect the release.",
      whileWaiting: { mode: "ask", instructions: "Consider notifying the owner." }, enabled: true,
      scheduleIntervalSeconds: 60, generation: 1, contextMarkdown: "", contextRevision: 1,
      recentSourceKeys: [], relatedTaskIds: [], lastCheckStartedAtEpochMs: null,
      pendingRoutineFindings: [], lastAttemptAtEpochMs: null,
      lastSuccessfulReportAtEpochMs: null, updatedAtEpochMs: 1,
    } satisfies RoutineConfigurationDto;
    const markup = renderToStaticMarkup(createElement(RoutineContextEditor, {
      routine,
      stepRetryDelaySeconds: 300,
      completionEvidence: "The production release is visible.",
      health: undefined,
      reports: [],
      busy: false,
      setupImprovement: () => undefined,
      runNow: async () => undefined,
      save: async () => undefined,
      saveInstructions: async () => undefined,
      saveStewardInstructions: async () => undefined,
      saveActionHandling: async () => undefined,
      reload: async () => undefined,
    }));
    expect(markup).toContain("Ready");
    expect(markup).toContain("Next:");
    expect(markup).toContain("Worker Context");
    expect(markup).toContain("Auto-managed");
    expect(markup).toContain("Clear memory");
    expect(markup).toContain("Session JSONL");
    expect(markup).toContain("What should the Worker look for?");
    expect(markup).toContain("When is this Playbook step complete?");
    expect(markup).toContain("What should the Steward consider doing?");
    expect(markup).toContain("How may the Steward handle an action?");
    expect(markup).toContain("Record only");
    expect(markup).toContain("Ask me");
    expect(markup).toContain("Auto if allowed");
    expect(markup).not.toContain("Action handling");
    expect(markup.lastIndexOf("Worker Context")).toBeGreaterThan(markup.lastIndexOf("Processed sources"));
  });

  it("keeps proven, unavailable, and unproven states distinct", () => {
    expect(capabilityMark("proven")).toBe("✓");
    expect(capabilityMark("unavailable")).toBe("✕");
    expect(capabilityMark("unknown")).toBe("?");
    expect(capabilityCopy("unknown", "claude")).toContain("Claude CLI subscription");
    expect(capabilityCopy("unknown", "codex")).toContain("could not be confirmed");
  });

  it("makes it explicit that a disabled or unproven Steward cannot reply", () => {
    expect(stewardReplyAvailabilityCopy(false, "proven")).toContain("enabled and saved");
    expect(stewardReplyAvailabilityCopy(false, "unknown")).toContain("shows green");
    expect(stewardReplyAvailabilityCopy(true, "proven")).toBeUndefined();
  });

  it("shows the separate Companion supervisor state", () => {
    expect(companionSupervisorCopy("available")).toContain("online");
    expect(companionSupervisorCopy("starting")).toContain("starting");
    expect(companionSupervisorCopy("unavailable")).toContain("unavailable");
  });

  it("tells the user how to recover after fixing an assignment problem", () => {
    expect(routineProblemRecoveryCopy("Worker 1")).toBe("Fixed it? Restart Worker 1 from the sidebar.");
    expect(routineProblemRecoveryCopy()).toContain("Restart the Worker");
  });

  it("keeps panel identity stable across projection invalidations", () => {
    expect(stewardPanelIdentity("project-1")).toBe("project-1:steward");
    expect(stewardPanelIdentity("project-1", { kind: "routine", routineId: "routine-1" }))
      .toBe("project-1:routine:routine-1");
  });

  it("reconciles Workspace messages and keeps the current Steward question actionable", () => {
    const suggestion = {
      id: "suggestion-1", projectId: "project-1", sequence: 1, author: "steward",
      kind: "suggestion", content: "Review the failed check.", createdAtEpochMs: 1,
    } satisfies CompanionMessageDto;
    const proposal = {
      ...suggestion, id: "proposal-2", sequence: 2, kind: "proposal", content: "May I restart it?",
    } satisfies CompanionMessageDto;
    const update = {
      ...suggestion, id: "update-3", sequence: 3, kind: "update", content: "The current state changed.",
    } satisfies CompanionMessageDto;

    expect(mergeCompanionMessages([proposal], [suggestion, proposal]).map((message) => message.id))
      .toEqual(["proposal-2", "suggestion-1"]);
    expect(pendingCompanionProposalId([suggestion, proposal, update])).toBe("proposal-2");
    expect(actionableCompanionSuggestionId([suggestion])).toBe("suggestion-1");
  });

  it("keeps first-run Playbook guidance after the pipeline status strip is removed", () => {
    const withSteps = {
      projectId: "project-1", revision: 1, activePipelineName: "Delivery",
      milestones: [{ id: "ms-1", title: "Build green", gate: "automatic", routineId: "r-1", retryDelaySeconds: 600, completeWhen: "CI green", whileWaiting: { mode: "off", instructions: "" }, workerId: "worker-1", approver: null }],
      savedPipelines: [], updatedAtEpochMs: 1,
    } satisfies PlaybookDto;

    expect(playbookOnboardingCta(null, undefined)).toEqual({ action: "setup" });
    expect(playbookOnboardingCta(null, "builder-session-1")).toEqual({ action: "open" });
    expect(playbookOnboardingCta(withSteps, "builder-session-1")).toBeNull();
  });

  it("does not let an older mutation response regress a loaded Routine", () => {
    const base = {
      id: "routine-1",
      projectId: "project-1",
      triggerMode: "schedule",
      name: "Slack",
      workerId: "worker-1",
      enabled: false,
      scheduleIntervalSeconds: 300,
      instructions: "Visible prompt",
      whileWaiting: { mode: "off", instructions: "Review new findings." },
      generation: 2,
      contextMarkdown: "",
      contextRevision: 1,
      recentSourceKeys: [],
      relatedTaskIds: [],
      pendingRoutineFindings: [],
      lastCheckStartedAtEpochMs: null,
      lastAttemptAtEpochMs: null,
      lastSuccessfulReportAtEpochMs: null,
      updatedAtEpochMs: 20,
    } satisfies RoutineConfigurationDto;
    const older = { ...base, generation: 1, updatedAtEpochMs: 10 } satisfies RoutineConfigurationDto;
    expect(upsertRoutineConfiguration([base], older)).toEqual([base]);
    expect(upsertRoutineConfiguration([], older)).toEqual([older]);
  });

  it("updates only visible Routine instructions and preserves its other configuration", () => {
    const routine = {
      id: "routine-1", projectId: "project-1", workerId: "worker-1",
      triggerMode: "schedule",
      name: "Customer pulse", instructions: "Old instructions", enabled: true,
      whileWaiting: { mode: "ask", instructions: "Old response instructions" },
      scheduleIntervalSeconds: 2700, generation: 1, contextMarkdown: "", contextRevision: 1,
      recentSourceKeys: [], relatedTaskIds: [], lastCheckStartedAtEpochMs: null,
      pendingRoutineFindings: [],
      lastAttemptAtEpochMs: null, lastSuccessfulReportAtEpochMs: null, updatedAtEpochMs: 1,
    } satisfies RoutineConfigurationDto;
    expect(routineInstructionsUpdateParams(routine, "New instructions", 9)).toEqual({
      routineId: "routine-1",
      triggerMode: "schedule",
      workerId: "worker-1",
      name: "Customer pulse",
      instructions: "New instructions",
      whileWaiting: { mode: "ask", instructions: "Old response instructions" },
      enabled: true,
      scheduleIntervalSeconds: 2700,
      expectedRevision: 9,
    });
    expect(routineActionHandlingUpdateParams(routine, "auto", 10)).toEqual({
      routineId: "routine-1",
      triggerMode: "schedule",
      workerId: "worker-1",
      name: "Customer pulse",
      instructions: "Old instructions",
      whileWaiting: { mode: "auto", instructions: "Old response instructions" },
      enabled: true,
      scheduleIntervalSeconds: 2700,
      expectedRevision: 10,
    });
    expect(routineStewardInstructionsUpdateParams(routine, "New response instructions", 11)).toEqual({
      routineId: "routine-1",
      triggerMode: "schedule",
      workerId: "worker-1",
      name: "Customer pulse",
      instructions: "Old instructions",
      whileWaiting: { mode: "ask", instructions: "New response instructions" },
      enabled: true,
      scheduleIntervalSeconds: 2700,
      expectedRevision: 11,
    });

    const stepRoutine = { ...routine, triggerMode: "onDemand" } satisfies RoutineConfigurationDto;
    expect(routineActionHandlingUpdateParams(stepRoutine, "auto", 12)).toEqual({
      routineId: "routine-1",
      triggerMode: "onDemand",
      workerId: "worker-1",
      name: "Customer pulse",
      instructions: "Old instructions",
      whileWaiting: { mode: "auto", instructions: "Old response instructions" },
      enabled: true,
      scheduleIntervalSeconds: 2700,
      expectedRevision: 12,
    });
  });

  it("retries a write the daemon's own state change outran, and nothing else", async () => {
    // Enabling a Worker launches its Session; that write moves the revision
    // between two of ours. Recognising the daemon's exact words is what keeps
    // a template adoption from stopping halfway.
    expect(isRevisionConflict(new Error(
      "Error invoking remote method 'termloop:routine-configuration-create': "
      + "TermLoopControlError: state revision changed; refresh and try again",
    ))).toBe(true);
    expect(isRevisionConflict(new Error("record not found"))).toBe(false);

    const cited: number[] = [];
    const conflicted = await withCurrentRevision(7, async () => 12, async (expectedRevision) => {
      cited.push(expectedRevision);
      if (expectedRevision === 7) throw new Error("state revision changed; refresh and try again");
      return "written";
    });
    // The second attempt carries the revision just read, not the stale one.
    expect(cited).toEqual([7, 12]);
    expect(conflicted).toBe("written");

    // A write that succeeds is never repeated.
    const once: number[] = [];
    await withCurrentRevision(3, async () => 99, async (expectedRevision) => {
      once.push(expectedRevision);
      return "written";
    });
    expect(once).toEqual([3]);

    // A real failure surfaces instead of being retried into a double write.
    const attempts: number[] = [];
    await expect(withCurrentRevision(3, async () => 99, async (expectedRevision) => {
      attempts.push(expectedRevision);
      throw new Error("record not found");
    })).rejects.toThrow("record not found");
    expect(attempts).toEqual([3]);
  });

  it("keeps re-citing the revision while a busy Project keeps moving it", async () => {
    // The revision is global: a Worker ping or a Routine finishing moves it
    // between the read and the write. One retry loses that race often enough
    // that a working button reports failure, so a few are allowed.
    let revision = 10;
    const cited: number[] = [];
    const written = await withCurrentRevision(revision, async () => (revision += 1), async (expectedRevision) => {
      cited.push(expectedRevision);
      if (expectedRevision < 13) throw new Error("state revision changed; refresh and try again");
      return "written";
    });
    expect(cited).toEqual([10, 11, 12, 13]);
    expect(written).toBe("written");

    // It is bounded, not endless: a revision that never settles still reports.
    const forever: number[] = [];
    await expect(withCurrentRevision(1, async () => 1, async (expectedRevision) => {
      forever.push(expectedRevision);
      throw new Error("state revision changed; refresh and try again");
    })).rejects.toThrow("state revision changed");
    expect(forever).toHaveLength(4);
  });

  it("strips the IPC wrapper so a plain rule does not read as a crash", () => {
    // What reached the user was the Electron channel name in front of the
    // daemon's sentence. The channel is not something they can act on.
    expect(assistantRefusalMessage(new Error(
      "Error invoking remote method 'termloop:routine-configuration-delete': "
      + "TermLoopControlError: state revision changed; refresh and try again",
    ))).toBe("state revision changed; refresh and try again");
    // A wrapped bare store rule is still not worth repeating at the user.
    expect(assistantRefusalMessage(new Error(
      "Error invoking remote method 'termloop:worker-configuration-delete': "
      + "TermLoopControlError: store failed: constraint violation",
    ))).toBe("The change didn't apply. Try again.");
  });

  it("adds a later question to the Worker its pipeline already runs in", () => {
    const workers = [
      { id: "worker-1", name: "Worker 1", enabled: true },
      { id: "worker-ship", name: "Ship to production", enabled: true },
    ] as unknown as Parameters<typeof playbookPipelineWorkerId>[2];
    const routines = [
      { id: "routine-step-1", workerId: "worker-ship" },
      { id: "routine-step-2", workerId: "worker-ship" },
    ] as unknown as Parameters<typeof playbookPipelineWorkerId>[1];
    const saved = {
      milestones: [{ routineId: "routine-step-1" }, { routineId: "routine-step-2" }],
    } as Parameters<typeof playbookPipelineWorkerId>[0];
    // The template opened its own Worker, so a question added later belongs
    // beside the others rather than in whichever Worker the sidebar lists first.
    expect(playbookPipelineWorkerId(saved, routines, workers)).toBe("worker-ship");
    // A milestone whose Routine is gone is skipped, not treated as authority.
    const stale = {
      milestones: [{ routineId: "routine-gone" }, { routineId: "routine-step-2" }],
    } as Parameters<typeof playbookPipelineWorkerId>[0];
    expect(playbookPipelineWorkerId(stale, routines, workers)).toBe("worker-ship");
    // With no pipeline yet there is nothing to join, so the first enabled
    // Worker takes it; Core never receives a known-unusable default.
    expect(playbookPipelineWorkerId(null, routines, workers)).toBe("worker-1");
    const stoppedFirst = [
      { id: "worker-off", enabled: false },
      { id: "worker-on", enabled: true },
    ] as unknown as Parameters<typeof playbookPipelineWorkerId>[2];
    expect(playbookPipelineWorkerId(null, routines, stoppedFirst)).toBe("worker-on");
    expect(playbookPipelineWorkerId(null, [], [])).toBeUndefined();
  });

  it("shows a Routine's current run timing without inventing history", () => {
    expect(routineTimeCopy(null)).toBe("Never");
    expect(routineTimeCopy(1_000)).not.toBe("Never");
  });

});

describe("Retiring the Routine behind a question the board dropped", () => {
  it("deletes the Routine in one write, whatever state it is in", async () => {
    const calls: string[] = [];
    const retired = await retireStepRoutine("r-1", 7, {
      currentRevision: async () => { calls.push("read"); return 99; },
      deleteRoutine: async (_id, expectedRevision) => {
        calls.push(`delete:${expectedRevision}`);
        return { routineId: "r-1", deleted: true, stateRevision: 8 } as never;
      },
    });

    // A running or switched-on Routine is no longer a reason to write to it
    // first: the daemon takes it and its remaining questions in one command.
    expect(calls).toEqual(["delete:7"]);
    expect(retired).toEqual({ stateRevision: 8 });
  });

  it("retries a lost revision race against the current revision", async () => {
    const calls: string[] = [];
    const retired = await retireStepRoutine("r-1", 7, {
      currentRevision: async () => { calls.push("read"); return 99; },
      deleteRoutine: async (_id, expectedRevision) => {
        calls.push(`delete:${expectedRevision}`);
        if (expectedRevision === 7) throw new Error("state revision changed; refresh and try again");
        return { routineId: "r-1", deleted: true, stateRevision: 100 } as never;
      },
    });
    expect(calls).toEqual(["delete:7", "read", "delete:99"]);
    expect(retired).toEqual({ stateRevision: 100 });
  });

  it("returns the daemon's refusal instead of letting the call escape", async () => {
    const retired = await retireStepRoutine("r-1", 7, {
      currentRevision: async () => 99,
      deleteRoutine: async () => {
        throw new Error("this Project no longer exists");
      },
    });
    expect(retired).toEqual({ error: "this Project no longer exists" });
  });
});
