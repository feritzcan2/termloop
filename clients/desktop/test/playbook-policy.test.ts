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
  removeMilestoneAt,
  resolvePlaybookSave,
  switchToSavedPipeline,
  truncatePlaybookLabel,
  utf8ByteLength,
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

  it("moves, removes, and retimes steps without mutating the source", () => {
    expect(moveMilestoneToSlot(draft(), 2, 0).milestones.map((entry) => entry.title))
      .toEqual(["Three", "One", "Two"]);
    // A station's own edges are no-ops, so an inline ↑ at the top changes nothing.
    expect(moveMilestoneToSlot(draft(), 0, 0)).toEqual(draft());
    expect(removeMilestoneAt(draft(), 1).milestones.map((entry) => entry.title)).toEqual(["One", "Three"]);
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
    }]);
    expect(wire[0]).not.toHaveProperty("routineId");
  });

  it("keeps a brand-new step provider-neutral with no preparatory write", () => {
    const wire = playbookMilestonesForWire([{
      id: "ci-green", title: "Is CI green?", gate: "automatic",
      routineId: null, retryDelaySeconds: 600, completeWhen: "Required checks pass.",
      whileWaiting: { mode: "off", instructions: "" }, approver: null,
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
    expect(PLAYBOOK_STARTER.milestones[0]?.title).toBe("Agent is working");
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
