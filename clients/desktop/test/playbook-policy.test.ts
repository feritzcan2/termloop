import { describe, expect, it } from "vitest";
import type { PlaybookDto, PlaybookMilestoneDto } from "@termloop/contract/current";
import {
  PLAYBOOK_MILESTONES_MAX,
  PLAYBOOK_STARTER,
  PLAYBOOK_TEMPLATES,
  adoptTemplateInto,
  boardAlreadyRuns,
  changeMilestoneRetryAt,
  moveMilestoneToSlot,
  playbookDraftFromDto,
  playbookDraftIsValid,
  playbookDraftIssues,
  playbookMilestoneIssues,
  playbookMilestoneFieldIssues,
  playbookMilestonesForWire,
  playbookRefusalMessage,
  playbookRetryChoices,
  playbookStarterDraft,
  playbookStationApproverCaption,
  playbookTemplateDraft,
  resolvePlaybookSave,
  switchToSavedPipeline,
  truncatePlaybookLabel,
  utf8ByteLength,
  changeMilestoneAgentReportForRoutine,
  changeMilestoneCheckForRoutine,
  changeMilestoneEvaluatorModelsForRoutine,
  changeMilestoneActiveHoursForRoutine,
  playbookActiveHoursIssue,
  playbookToggleWeekday,
  playbookActiveHoursEqual,
  playbookActiveHoursLabel,
  playbookMinuteFromLabel,
  playbookMinuteLabel,
  playbookStepModelIssue,
  normalizePlaybookMilestone,
  playbookCheckCaption,
  playbookFallbackNeedsIntegrations,
  playbookFallbackReasonCopy,
  playbookMilestoneWithGate,
} from "../src/renderer/ui/playbook-policy.js";

function milestone(overrides: Partial<PlaybookMilestoneDto> = {}): PlaybookMilestoneDto {
  return {
    id: "pr-approved",
    title: "PR approved",
    gate: "human",
    routineId: "routine-pr",
    retryDelaySeconds: 600,
    completeWhen: "PR review projection shows an approval.",
    whileWaiting: {
      mode: "ask",
      instructions: "Propose asking the reviewer and ask the user whether to send it.",
    },
    approver: "ferit",
    deterministicCheck: null, agentReport: "signal",
    ...overrides,
  };
}

function playbook(overrides: Partial<PlaybookDto> = {}): PlaybookDto {
  return {
    projectId: "project-1",
    revision: 3,
    activePipelineName: "Ship to production",
    milestones: [milestone()],
    savedPipelines: [],
    updatedAtEpochMs: 1,
    ...overrides,
  };
}

describe("Playbook policy validation", () => {
  it("keeps gate, id, utf8, and retry invariants visible before Save", () => {
    expect(playbookMilestoneIssues(milestone())).toEqual([]);
    expect(playbookMilestoneIssues(milestone({ approver: null }))).toContain("A human gate names its approver.");
    expect(playbookMilestoneIssues(milestone({ gate: "automatic", approver: "ferit" })))
      .toContain("An automatic milestone cannot have an approver.");
    expect(playbookMilestoneIssues(milestone({ id: "no spaces" }))[0]).toMatch(/ID must be/);
    expect(playbookMilestoneIssues(milestone({ title: "🛰".repeat(41) }))[0]).toMatch(/too long/);
    expect(utf8ByteLength("🛰".repeat(41))).toBeGreaterThan(120);
    expect(playbookMilestoneIssues(milestone({ retryDelaySeconds: 30 })))
      .toContain("Check again between 1 minute and 24 hours.");
    expect(playbookMilestoneFieldIssues(milestone({ approver: null })).approver)
      .toEqual(["A human gate names its approver."]);
  });

  it("rejects duplicate and oversized documents", () => {
    expect(playbookDraftIssues({
      activePipelineName: "Ship", milestones: [milestone(), milestone()], savedPipelines: [],
    })).toContain("Milestone IDs must be unique.");
    const full = Array.from({ length: PLAYBOOK_MILESTONES_MAX }, (_, index) => milestone({ id: `m-${index}` }));
    expect(playbookDraftIsValid({ activePipelineName: "Ship", milestones: full, savedPipelines: [] })).toBe(true);
    expect(playbookDraftIssues({
      activePipelineName: "Ship", milestones: [...full, milestone({ id: "extra" })], savedPipelines: [],
    })[0]).toMatch(/At most/);
  });
});

describe("Inline pipeline edits", () => {
  const draft = () => ({
    activePipelineName: "Ship",
    milestones: [
      milestone({ id: "one", title: "One", gate: "automatic", approver: null }),
      milestone({ id: "two", title: "Two", gate: "automatic", approver: null }),
      milestone({ id: "three", title: "Three", gate: "automatic", approver: null }),
    ],
    savedPipelines: [],
  });

  it("moves and retimes steps without mutating the source", () => {
    expect(moveMilestoneToSlot(draft(), 2, 0).milestones.map((entry) => entry.title))
      .toEqual(["Three", "One", "Two"]);
    // A station's own edges are no-ops, so an inline ↑ at the top changes nothing.
    expect(moveMilestoneToSlot(draft(), 0, 0)).toEqual(draft());
    const retimed = changeMilestoneRetryAt(draft(), 1, 1800);
    expect(retimed.milestones.map((entry) => entry.retryDelaySeconds)).toEqual([600, 1800, 600]);
    expect(draft().milestones[1]?.retryDelaySeconds).toBe(600);
  });

  it("offers the standard recheck choices plus an existing off-menu value", () => {
    expect(playbookRetryChoices(600)).toEqual([300, 600, 1800, 3600, 14_400, 86_400]);
    expect(playbookRetryChoices(900)).toEqual([300, 600, 900, 1800, 3600, 14_400, 86_400]);
  });

  it("parks and restores whole pipelines", () => {
    const source = {
      activePipelineName: "Ship",
      milestones: [milestone({ id: "ship" })],
      savedPipelines: [{ name: "Review", milestones: [milestone({ id: "review" })] }],
    };
    const switched = switchToSavedPipeline(source, "Review");
    expect(switched?.activePipelineName).toBe("Review");
    expect(switched?.savedPipelines[0]?.name).toBe("Ship");
    expect(switchToSavedPipeline(switched!, "Ship")?.milestones).toEqual(source.milestones);
  });
});

describe("Atomic Playbook mutation payload", () => {
  it("sends the flat completion policy and never sends client-owned Routine identity", () => {
    const draft = playbookDraftFromDto(playbook());
    const wire = playbookMilestonesForWire(draft.milestones);
    expect(wire).toEqual([{
      id: "pr-approved",
      title: "PR approved",
      gate: "human",
      retryDelaySeconds: 600,
      completeWhen: "PR review projection shows an approval.",
      whileWaiting: {
        mode: "ask",
        instructions: "Propose asking the reviewer and ask the user whether to send it.",
      },
      approver: "ferit",
      deterministicCheck: null, agentReport: "signal",
    }]);
    expect(wire[0]).not.toHaveProperty("routineId");
  });

  it("keeps a brand-new step provider-neutral with no preparatory write", () => {
    const wire = playbookMilestonesForWire([{
      id: "ci-green", title: "Is CI green?", gate: "automatic",
      routineId: null, retryDelaySeconds: 600, completeWhen: "Required checks pass.",
      whileWaiting: { mode: "off", instructions: "" }, approver: null, deterministicCheck: null, agentReport: "signal",
    }]);
    expect(wire[0]).toMatchObject({
      completeWhen: "Required checks pass.",
      whileWaiting: { mode: "off", instructions: "" },
    });
  });

  it("uses document CAS and refreshes store CAS", () => {
    const draft = playbookDraftFromDto(playbook());
    const decision = resolvePlaybookSave(
      "project-1", draft, 3, { playbook: playbook(), stateRevision: 55 },
    );
    expect(decision.kind).toBe("proceed");
    if (decision.kind !== "proceed") return;
    expect(decision.params.expectedPlaybookRevision).toBe(3);
    expect(decision.params.expectedRevision).toBe(55);
    expect(decision.params).not.toHaveProperty("workerId");
    expect(decision.params).not.toHaveProperty("preferredWorkerAgentId");

    expect(resolvePlaybookSave(
      "project-1", draft, 3, { playbook: playbook({ revision: 4 }), stateRevision: 56 },
    )).toEqual({ kind: "conflict" });
  });

  it("copies loaded documents and their completion policy independently", () => {
    const source = playbook();
    const draft = playbookDraftFromDto(source);
    draft.milestones[0]!.title = "Changed";
    expect(source.milestones[0]?.title).toBe("PR approved");
    expect(draft.milestones[0]?.completeWhen).toBe("PR review projection shows an approval.");
  });
});

describe("Playbook templates", () => {
  it("keeps observation and provider-neutral Steward follow-up separate", () => {
    const template = PLAYBOOK_TEMPLATES.find((entry) => entry.id === "dev-pr-to-production")!;
    const draft = playbookTemplateDraft(template);
    expect(draft.milestones.every((entry) => entry.routineId === null)).toBe(true);
    const reviewRequest = draft.milestones.find((entry) => entry.id === "review-requested")!;
    expect(reviewRequest.completeWhen).toContain("visible message");
    expect(reviewRequest.whileWaiting.mode).toBe("ask");
    expect(reviewRequest.whileWaiting.instructions).toContain("existing Task Agent");
    expect(JSON.stringify(reviewRequest)).not.toMatch(/Slack|Nurguyl/);
  });

  it("adopts without provisioning side effects and parks the current board", () => {
    const template = PLAYBOOK_TEMPLATES[0]!;
    const current = { activePipelineName: "Mine", milestones: [milestone()], savedPipelines: [] };
    const adopted = adoptTemplateInto(current, template);
    expect(adopted?.activePipelineName).toBe(template.name);
    expect(adopted?.milestones).toHaveLength(5);
    expect(adopted?.savedPipelines[0]?.name).toBe("Mine");
    expect(boardAlreadyRuns(adopted!, template)).toBe(true);
    expect(adoptTemplateInto(adopted!, template)).toBeUndefined();
  });

  it("switches back to a kept pipeline instead of minting duplicate Routines", () => {
    const template = PLAYBOOK_TEMPLATES[0]!;
    const kept = {
      activePipelineName: "Mine",
      milestones: [milestone()],
      savedPipelines: [{ name: template.name, milestones: [milestone({ id: "kept-step" })] }],
    };
    const adopted = adoptTemplateInto(kept, template);
    expect(adopted?.activePipelineName).toBe(template.name);
    // The kept pipeline's own steps come back; the template does not restamp them.
    expect(adopted?.milestones.map((entry) => entry.id)).toEqual(["kept-step"]);
    expect(adopted?.savedPipelines.map((pipeline) => pipeline.name)).toEqual(["Mine"]);
  });

  it("keeps the starter immutable and valid", () => {
    const starter = playbookStarterDraft();
    expect(playbookDraftIsValid(starter)).toBe(true);
    starter.milestones[0]!.title = "Changed";
    expect(PLAYBOOK_STARTER.milestones[0]?.title).toBe("Committed");
  });
});

describe("Playbook labels", () => {
  it("keeps refusal text actionable", () => {
    expect(playbookRefusalMessage("playbook")).toContain("Each pipeline needs its own name");
    expect(playbookRefusalMessage("state revision changed; refresh and try again"))
      .toBe("state revision changed; refresh and try again");
    expect(truncatePlaybookLabel("a".repeat(30))).toBe(`${"a".repeat(23)}…`);
  });

  it("captions human gates by who they wait on", () => {
    expect(playbookStationApproverCaption({ gate: "automatic", approver: null })).toBeUndefined();
    expect(playbookStationApproverCaption({ gate: "human", approver: null })).toBe("needs an approver");
    expect(playbookStationApproverCaption({ gate: "human", approver: "ferit" })).toBe("waits on ferit");
  });
});

describe("Deterministic pull request checks", () => {
  const automatic = () => milestone({
    id: "pr-merged", title: "PR merged", gate: "automatic", approver: null, routineId: "routine-merged",
  });

  it("defaults a missing check to the agent Routine for older or Builder-relayed data", () => {
    const { deterministicCheck: _omitted, ...legacy } = automatic();
    expect(normalizePlaybookMilestone<PlaybookMilestoneDto>(legacy).deterministicCheck).toBeNull();
    const draft = playbookDraftFromDto(playbook({
      milestones: [legacy as PlaybookMilestoneDto],
      savedPipelines: [{ name: "Kept", milestones: [legacy as PlaybookMilestoneDto] }],
    }));
    expect(draft.milestones[0]?.deterministicCheck).toBeNull();
    expect(draft.savedPipelines[0]?.milestones[0]?.deterministicCheck).toBeNull();
    expect(playbookMilestonesForWire(draft.milestones)[0]).toHaveProperty("deterministicCheck", null);
  });

  it("sets a check on an automatic step wherever its pipeline is kept and sends it on the wire", () => {
    const check = { kind: "pullRequestMerged" as const, baseBranch: "dev" };
    const draft = playbookDraftFromDto(playbook({ milestones: [automatic()] }));
    const next = changeMilestoneCheckForRoutine(draft, "routine-merged", check);
    expect(next?.milestones[0]?.deterministicCheck).toEqual(check);
    expect(playbookMilestonesForWire(next!.milestones)[0]?.deterministicCheck).toEqual(check);

    const kept = playbookDraftFromDto(playbook({ milestones: [], savedPipelines: [{ name: "Kept", milestones: [automatic()] }] }));
    expect(changeMilestoneCheckForRoutine(kept, "routine-merged", check)?.savedPipelines[0]?.milestones[0]?.deterministicCheck)
      .toEqual(check);
    expect(changeMilestoneCheckForRoutine(draft, "missing", check)).toBeUndefined();
  });

  it("refuses a check on a human gate and clears it when a step becomes one", () => {
    const human = playbookDraftFromDto(playbook());
    expect(changeMilestoneCheckForRoutine(human, "routine-pr", { kind: "pullRequestOpen", baseBranch: null })).toBeUndefined();
    expect(changeMilestoneCheckForRoutine(human, "routine-pr", null)?.milestones[0]?.deterministicCheck).toBeNull();

    const checked = { ...automatic(), deterministicCheck: { kind: "pullRequestOpen" as const, baseBranch: null } };
    const gated = playbookMilestoneWithGate(checked, "human", "ferit");
    expect(gated).toMatchObject({ gate: "human", approver: "ferit", deterministicCheck: null });
    expect(playbookMilestoneWithGate(gated, "automatic")).toMatchObject({ gate: "automatic", approver: null });

    expect(playbookMilestoneFieldIssues({ ...milestone(), deterministicCheck: checked.deterministicCheck }).check)
      .toEqual(["A human gate waits for its approver and cannot use a pull request check."]);
    expect(playbookMilestoneFieldIssues({ ...checked, deterministicCheck: { kind: "pullRequestOpen", baseBranch: " " } }).check)
      .toEqual(["Base branch is required."]);
    expect(playbookMilestoneFieldIssues(checked).check).toEqual([]);
    expect(playbookMilestoneFieldIssues({ ...checked, deterministicCheck: { kind: "pullRequestMerged", baseBranch: "feature x" } }).check)
      .toEqual(["Base branch cannot contain spaces."]);
  });

  it("captions checks and explains fallbacks in the provider's name", () => {
    expect(playbookCheckCaption(null)).toBeUndefined();
    expect(playbookCheckCaption({ kind: "pullRequestChecksPassing", baseBranch: null })).toBe("PR checks passing");
    expect(playbookCheckCaption({ kind: "pullRequestMerged", baseBranch: "main" })).toBe("PR merged → main");
    expect(playbookFallbackReasonCopy("unauthorized", "github")).toBe("Fell back to agent routine: GitHub not signed in");
    expect(playbookFallbackReasonCopy("checksUnsupported", "azureDevOps"))
      .toBe("Fell back to agent routine: Azure DevOps does not report build checks for this pull request");
    expect(playbookFallbackReasonCopy("noTaskBranch", null)).toBe("Fell back to agent routine: the Task has no branch yet");
    expect(["unauthorized", "providerUnavailable", "checksUnsupported"].every((reason) =>
      playbookFallbackNeedsIntegrations(reason as "unauthorized"))).toBe(true);
    expect(playbookFallbackNeedsIntegrations("rateLimited")).toBe(false);
    expect(playbookFallbackNeedsIntegrations(null)).toBe(false);
  });

  it("counts commits without a base branch and opens every template with that check", () => {
    const committed = { kind: "branchCommitted", baseBranch: null } as const;
    expect(playbookCheckCaption(committed)).toBe("Committed");
    expect(playbookFallbackReasonCopy("commitsUnavailable", "github"))
      .toBe("Fell back to agent routine: the Task branch's commits could not be counted");
    const step = milestone({ gate: "automatic", approver: null, deterministicCheck: committed });
    expect(playbookMilestoneFieldIssues(step).check).toEqual([]);
    expect(playbookMilestoneFieldIssues({ ...step, deterministicCheck: { ...committed, baseBranch: "main" } }).check)
      .toEqual(["A commit check counts from the Task branch's own base and takes no base branch."]);
    for (const draft of [playbookStarterDraft(), ...PLAYBOOK_TEMPLATES.map(playbookTemplateDraft)]) {
      expect(draft.milestones[0]?.deterministicCheck).toEqual(committed);
      expect(playbookDraftIsValid(draft)).toBe(true);
    }
  });
});

describe("Task Agent step reports", () => {
  const automatic = () => milestone({
    id: "pr-merged", title: "PR merged", gate: "automatic", approver: null, routineId: "routine-merged",
  });

  it("defaults an older step to signal and never lets a human gate trust a report", () => {
    const { agentReport: _omitted, ...legacy } = automatic();
    expect(normalizePlaybookMilestone<PlaybookMilestoneDto>(legacy).agentReport).toBe("signal");

    const draft = playbookDraftFromDto(playbook({ milestones: [automatic()] }));
    const trusted = changeMilestoneAgentReportForRoutine(draft, "routine-merged", "trusted");
    expect(trusted?.milestones[0]?.agentReport).toBe("trusted");
    expect(playbookMilestonesForWire(trusted!.milestones)[0]?.agentReport).toBe("trusted");

    const human = playbookDraftFromDto(playbook());
    expect(changeMilestoneAgentReportForRoutine(human, "routine-pr", "trusted")).toBeUndefined();
    expect(changeMilestoneAgentReportForRoutine(human, "routine-pr", "off")?.milestones[0]?.agentReport).toBe("off");
    expect(playbookMilestoneWithGate({ ...automatic(), agentReport: "trusted" }, "human", "ferit").agentReport).toBe("signal");
    expect(playbookMilestoneFieldIssues({ ...milestone(), agentReport: "trusted" }).gate).not.toHaveLength(0);
  });

  it("drops the new-pull-request restart when a step becomes a human gate", () => {
    const restarting = { ...automatic(), restartOnNewPullRequest: true };
    expect(playbookMilestoneFieldIssues(restarting).gate).toHaveLength(0);
    expect(playbookMilestoneWithGate(restarting, "human", "ferit").restartOnNewPullRequest).toBe(false);
    expect(playbookMilestoneWithGate(automatic(), "human", "ferit")).not.toHaveProperty("restartOnNewPullRequest");
    expect(playbookMilestoneFieldIssues({ ...milestone(), restartOnNewPullRequest: true }).gate).not.toHaveLength(0);
  });

  it("sets a step's own evaluator model and keeps it through the wire", () => {
    const draft = playbookDraftFromDto(playbook({ milestones: [automatic()] }));
    const chosen = changeMilestoneEvaluatorModelsForRoutine(draft, "routine-merged", { codexModel: " gpt-6-sol ", claudeModel: "" });
    expect(chosen?.milestones[0]?.evaluatorModels).toEqual({ codexModel: "gpt-6-sol", claudeModel: null });
    expect(playbookMilestonesForWire(chosen!.milestones)[0]?.evaluatorModels).toEqual({ codexModel: "gpt-6-sol", claudeModel: null });
    // Another step edit keeps the chosen model.
    const reported = changeMilestoneAgentReportForRoutine(playbookDraftFromDto(playbook({ milestones: chosen!.milestones.map((m) => ({ ...m, routineId: "routine-merged" })) })), "routine-merged", "off");
    expect(reported?.milestones[0]?.evaluatorModels).toEqual({ codexModel: "gpt-6-sol", claudeModel: null });
    // Following the Project for both providers stores null.
    expect(changeMilestoneEvaluatorModelsForRoutine(chosen!, "routine-merged", { codexModel: null, claudeModel: " " })?.milestones[0]?.evaluatorModels).toBeNull();
    expect(changeMilestoneEvaluatorModelsForRoutine(draft, "missing", null)).toBeUndefined();
    expect(playbookStepModelIssue("m".repeat(81))).toBeDefined();
    expect(playbookStepModelIssue("opus\n")).toBeDefined();
    expect(playbookStepModelIssue("my-custom-model")).toBeUndefined();
  });

  it("keeps the Playbook and step hours through a save and sends a cleared window as null", () => {
    const hours = { startMinute: 22 * 60, endMinute: 6 * 60, timeZone: "Europe/Istanbul" };
    const loaded = playbookDraftFromDto({ ...playbook({ milestones: [automatic()] }), activeHours: hours });
    const proceed = (draft: typeof loaded) => {
      const decision = resolvePlaybookSave("project-1", draft, 3, { playbook: playbook({ revision: 3 }), stateRevision: 55 });
      if (decision.kind !== "proceed") throw new Error("conflict");
      return decision.params;
    };
    expect(proceed(loaded).activeHours).toEqual(hours);
    expect(proceed({ ...loaded, activeHours: null })).toHaveProperty("activeHours", null);
    // A draft that never loaded a Playbook leaves the saved window alone.
    expect(proceed(playbookDraftFromDto(null))).not.toHaveProperty("activeHours");

    const stepped = changeMilestoneActiveHoursForRoutine(loaded, "routine-merged", { ...hours, startMinute: 9 * 60, endMinute: 17 * 60 });
    expect(playbookMilestonesForWire(stepped!.milestones)[0]?.activeHours).toEqual({ ...hours, startMinute: 540, endMinute: 1020 });
    expect(changeMilestoneActiveHoursForRoutine(stepped!, "routine-merged", null)?.milestones[0]?.activeHours).toBeNull();
    expect(changeMilestoneActiveHoursForRoutine(loaded, "missing", null)).toBeUndefined();
  });

  it("labels and validates active hours", () => {
    expect(playbookMinuteLabel(0)).toBe("00:00");
    expect(playbookMinuteLabel(1439)).toBe("23:59");
    expect(playbookMinuteFromLabel("09:30")).toBe(570);
    expect(playbookMinuteFromLabel("24:00")).toBeUndefined();
    expect(playbookMinuteFromLabel("")).toBeUndefined();
    expect(playbookActiveHoursLabel(null)).toBe("around the clock");
    expect(playbookActiveHoursLabel({ startMinute: 540, endMinute: 1080, timeZone: "UTC" })).toBe("09:00–18:00 UTC");
    expect(playbookActiveHoursIssue(null)).toBeUndefined();
    expect(playbookActiveHoursIssue({ startMinute: 540, endMinute: 540, timeZone: "UTC" })).toBeDefined();
    expect(playbookActiveHoursIssue({ startMinute: 540, endMinute: 600, timeZone: "Bad Zone" })).toBeDefined();
    expect(playbookActiveHoursIssue({ startMinute: 1320, endMinute: 360, timeZone: "Europe/Berlin" })).toBeUndefined();
    expect(playbookActiveHoursIssue({ startMinute: 540, endMinute: 600, timeZone: "UTC", weekdays: [] })).toBeDefined();
    const office = { startMinute: 540, endMinute: 1080, timeZone: "UTC" };
    const weekdays = playbookToggleWeekday(playbookToggleWeekday(office, "sunday"), "saturday");
    expect(weekdays.weekdays).toEqual(["monday", "tuesday", "wednesday", "thursday", "friday"]);
    expect(playbookActiveHoursLabel(weekdays)).toBe("09:00–18:00 Mon–Fri UTC");
    expect(playbookActiveHoursLabel({ ...office, weekdays: ["friday", "monday"] })).toBe("09:00–18:00 Mon, Fri UTC");
    // Switching every day back on reads as daily again.
    expect(playbookToggleWeekday(playbookToggleWeekday(weekdays, "saturday"), "sunday")).toEqual(office);
    expect(playbookActiveHoursEqual({ ...office, weekdays: [...weekdays.weekdays!] }, weekdays)).toBe(true);
    expect(playbookActiveHoursEqual(office, weekdays)).toBe(false);
  });
});
