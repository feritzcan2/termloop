import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CompanionTopicCard,
  PlaybookStateStrip,
  companionMessageBadge,
  companionProposalOutcome,
  companionSuggestionReplaced,
  companionSuggestionOutcome,
  currentStewardInteraction,
  groupCompanionTopics,
  playbookStateSummary,
} from "../src/renderer/ui/companion-chat.js";
import type { CompanionMessageDto, PlaybookDto, PlaybookRuntimeResult } from "@termloop/contract/current";

function message(overrides: Partial<CompanionMessageDto> & { id: string; sequence: number }): CompanionMessageDto {
  return {
    projectId: "project-1", author: "steward", kind: "reply",
    content: `Message ${overrides.sequence}`, createdAtEpochMs: overrides.sequence,
    ...overrides,
  };
}

describe("Proposal lifecycle", () => {
  const proposal = message({ id: "proposal-1", sequence: 2, kind: "proposal", content: "May I request approval?", refs: { taskId: "task-1" } });

  it("keeps a proposal pending only while no decisive message follows it", () => {
    expect(companionProposalOutcome([proposal], proposal)).toBe("pending");
  });

  it("keeps a proposal pending across later Steward status messages", () => {
    const update = message({ id: "update-1", sequence: 3, kind: "update", refs: { taskId: "task-1" }, content: "Builds are green." });
    const attention = message({ id: "attention-1", sequence: 4, kind: "attention", refs: { taskId: "task-1" }, content: "Your review is needed." });
    const problem = message({ id: "problem-1", sequence: 5, kind: "problem", refs: { taskId: "task-1" }, content: "Review age could not be verified." });
    const action = message({ id: "action-1", sequence: 6, kind: "action", content: "Refreshed the Task." });
    const thread = [action, problem, attention, update, proposal];
    expect(companionProposalOutcome(thread, proposal)).toBe("pending");
    expect(currentStewardInteraction(thread)?.id).toBe(proposal.id);
  });

  it("resolves a buried proposal from the user's receipt", () => {
    const update = message({ id: "update-1", sequence: 3, kind: "update", refs: { taskId: "task-1" }, content: "Builds are green." });
    const approved = message({ id: "receipt-1", sequence: 4, author: "user", kind: "approval", content: "Approved." });
    const declined = message({ id: "receipt-2", sequence: 4, author: "user", kind: "decline", content: "Not now." });
    expect(companionProposalOutcome([approved, update, proposal], proposal)).toBe("approved");
    expect(companionProposalOutcome([declined, update, proposal], proposal)).toBe("declined");
    expect(currentStewardInteraction([approved, update, proposal])).toBeNull();
  });

  it("marks a proposal superseded when the user answered something else or a newer question replaced it", () => {
    const reply = message({ id: "reply-1", sequence: 3, author: "user", content: "Tell me more first." });
    const newerProposal = message({ id: "proposal-2", sequence: 3, kind: "proposal", content: "Updated ask." });
    expect(companionProposalOutcome([reply, proposal], proposal)).toBe("superseded");
    expect(companionProposalOutcome([newerProposal, proposal], proposal)).toBe("superseded");
  });

  it("never lets a stale card keep demanding approval, and never retires a live one", () => {
    const reply = message({ id: "reply-1", sequence: 3, author: "user", content: "Not yet." });
    expect(companionMessageBadge([reply, proposal], proposal)).toEqual({ label: "Superseded", tone: "superseded" });
    expect(companionMessageBadge([proposal], proposal)).toEqual({ label: "Approval requested", tone: "pending" });
    const update = message({ id: "update-1", sequence: 3, kind: "update", content: "Builds are green." });
    expect(companionMessageBadge([update, proposal], proposal)).toEqual({ label: "Approval requested", tone: "pending" });
    const declined = message({ id: "receipt-1", sequence: 3, author: "user", kind: "decline", content: "Not now." });
    expect(companionMessageBadge([declined, proposal], proposal)).toEqual({ label: "Declined", tone: "declined" });
    expect(companionMessageBadge([declined, proposal], declined)).toEqual({ label: "Declined", tone: "declined" });
  });

  it("gives the status kinds plain generic chips that never route through approval", () => {
    const update = message({ id: "update-1", sequence: 1, kind: "update", content: "Builds are green." });
    const attention = message({ id: "attention-1", sequence: 2, kind: "attention", content: "Your review is needed." });
    const problem = message({ id: "problem-1", sequence: 3, kind: "problem", content: "Review age could not be verified." });
    const thread = [problem, attention, update];
    expect(companionMessageBadge(thread, update)).toEqual({ label: "Update", tone: "info" });
    expect(companionMessageBadge(thread, attention)).toEqual({ label: "Needs you", tone: "attention" });
    expect(companionMessageBadge(thread, problem)).toEqual({ label: "Evidence problem", tone: "problem" });
    expect(currentStewardInteraction(thread)).toBeNull();
  });

  it("labels decision receipts as receipts, not as completed work", () => {
    const approved = message({ id: "receipt-1", sequence: 3, author: "user", kind: "approval", content: "Approved." });
    expect(companionMessageBadge([approved], approved)).toEqual({ label: "Approved", tone: "approved" });
    const action = message({ id: "action-1", sequence: 4, kind: "action", content: "Closed the Task." });
    expect(companionMessageBadge([action], action)).toEqual({ label: "Completed", tone: "done" });
  });

  it("marks a suggestion replaced only by a newer Steward suggestion or proposal", () => {
    const suggestion = message({ id: "suggestion-1", sequence: 1, kind: "suggestion" });
    const reply = message({ id: "reply-1", sequence: 2, author: "user" });
    const update = message({ id: "update-1", sequence: 3, kind: "update" });
    const newer = message({ id: "suggestion-2", sequence: 4, kind: "suggestion" });
    expect(companionSuggestionReplaced([update, reply, suggestion], suggestion)).toBe(false);
    expect(companionMessageBadge([reply, suggestion], suggestion))
      .toEqual({ label: "Suggestion · superseded", tone: "superseded" });
    expect(companionSuggestionReplaced([newer, reply, suggestion], suggestion)).toBe(true);
    expect(companionMessageBadge([newer, reply, suggestion], suggestion))
      .toEqual({ label: "Suggestion · superseded", tone: "superseded" });
    const newerProposal = message({ id: "proposal-9", sequence: 4, kind: "proposal" });
    expect(companionSuggestionReplaced([newerProposal, reply, suggestion], suggestion)).toBe(true);
  });

  it("shows typed suggestion acceptance on the suggestion and receipt", () => {
    const suggestion = message({ id: "suggestion-1", sequence: 1, kind: "suggestion" });
    const update = message({ id: "update-1", sequence: 2, kind: "update" });
    const acceptance = message({
      id: "acceptance-1", sequence: 3, author: "user", kind: "acceptance",
      content: "Accepted. Proceed with this suggestion.",
    });
    const thread = [acceptance, update, suggestion];
    expect(companionSuggestionOutcome(thread, suggestion)).toBe("accepted");
    expect(companionMessageBadge(thread, suggestion)).toEqual({ label: "Accepted", tone: "approved" });
    expect(companionMessageBadge(thread, acceptance)).toEqual({ label: "Accepted", tone: "approved" });
    expect(currentStewardInteraction(thread)).toBeNull();
  });

  it("recognizes the exact legacy reply receipt as an accepted suggestion", () => {
    const suggestion = message({ id: "suggestion-1", sequence: 1, kind: "suggestion" });
    const legacyReceipt = message({
      id: "legacy-acceptance-1", sequence: 2, author: "user", kind: "reply",
      content: "Accepted. Proceed with this suggestion.",
    });
    const thread = [legacyReceipt, suggestion];
    expect(companionSuggestionOutcome(thread, suggestion)).toBe("accepted");
    expect(companionMessageBadge(thread, legacyReceipt)).toEqual({ label: "Accepted", tone: "approved" });
  });

  it("keeps a suggestion acceptable across Steward status messages", () => {
    const suggestion = message({ id: "suggestion-1", sequence: 1, kind: "suggestion" });
    const update = message({ id: "update-1", sequence: 2, kind: "update" });
    const problem = message({ id: "problem-1", sequence: 3, kind: "problem" });
    expect(currentStewardInteraction([problem, update, suggestion])?.id).toBe(suggestion.id);
    const reply = message({ id: "reply-1", sequence: 4, author: "user" });
    expect(currentStewardInteraction([reply, problem, update, suggestion])).toBeNull();
  });
});

describe("Topic grouping", () => {
  it("folds consecutive Steward updates about one Task into one card across kinds", () => {
    const progress = message({ id: "m1", sequence: 1, kind: "action", refs: { taskId: "task-1" }, content: "Started the Task Agent." });
    const update = message({ id: "m2", sequence: 2, kind: "update", refs: { taskId: "task-1" }, content: "Builds are green." });
    const ask = message({ id: "m3", sequence: 3, kind: "proposal", refs: { taskId: "task-1" }, content: "Approve the merge?" });
    const attention = message({ id: "m4", sequence: 4, kind: "attention", refs: { taskId: "task-1" }, content: "Your review is still needed." });
    const other = message({ id: "m5", sequence: 5, kind: "update", refs: { taskId: "task-2" }, content: "Another Task moved." });
    const groups = groupCompanionTopics([other, attention, ask, update, progress]);
    expect(groups.map((group) => group.items.length)).toEqual([1, 4]);
    expect(groups[1]!.id).toBe("m4");
    expect(groups[1]!.items.map((item) => item.message.id)).toEqual(["m4", "m3", "m2", "m1"]);
  });

  it("keeps user messages as their own bubbles", () => {
    const steward = message({ id: "m1", sequence: 1, refs: { taskId: "task-1" } });
    const user = message({ id: "m2", sequence: 2, author: "user", refs: { taskId: "task-1" } });
    const again = message({ id: "m3", sequence: 3, refs: { taskId: "task-1" } });
    expect(groupCompanionTopics([again, user, steward]).map((group) => group.items.length)).toEqual([1, 1, 1]);
  });

  it("collapses exact repeated wording into a count instead of another bubble", () => {
    const first = message({ id: "m1", sequence: 1, content: "Reminder: review is waiting." });
    const second = message({ id: "m2", sequence: 2, content: "Reminder: review is waiting." });
    const third = message({ id: "m3", sequence: 3, content: "Reminder: review is waiting." });
    const groups = groupCompanionTopics([third, second, first]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(1);
    expect(groups[0]!.items[0]!.repeatCount).toBe(3);
    expect(groups[0]!.items[0]!.message.id).toBe("m3");
  });

  it("links by Session and finding refs, not only by Task", () => {
    const bySession = [
      message({ id: "m2", sequence: 2, refs: { sessionId: "session-1" } }),
      message({ id: "m1", sequence: 1, refs: { sessionId: "session-1" } }),
    ];
    expect(groupCompanionTopics(bySession)).toHaveLength(1);
    const byBatchedFinding = [
      message({ id: "m4", sequence: 4, refs: { routineFindingId: "finding-2" } }),
      message({
        id: "m3", sequence: 3,
        refs: { routineFindingIds: ["finding-1", "finding-2"] },
      }),
    ];
    expect(groupCompanionTopics(byBatchedFinding)).toHaveLength(1);
    const unrelated = [
      message({ id: "m2", sequence: 2, refs: { taskId: "task-2" }, content: "B" }),
      message({ id: "m1", sequence: 1, refs: { taskId: "task-1" }, content: "A" }),
    ];
    expect(groupCompanionTopics(unrelated)).toHaveLength(2);
  });
});

describe("Topic card rendering", () => {
  const respond = () => undefined;
  const acceptSuggestion = () => undefined;

  it("shows approval controls only on the exact pending proposal", () => {
    const proposal = message({ id: "proposal-1", sequence: 1, kind: "proposal", content: "May I restart it?" });
    const [group] = groupCompanionTopics([proposal]);
    const pendingMarkup = renderToStaticMarkup(createElement(CompanionTopicCard, {
      group: group!, messages: [proposal], pendingProposalId: proposal.id,
      actionableSuggestionId: null, busy: false, respond, acceptSuggestion,
    }));
    expect(pendingMarkup).toContain("Approval requested");
    expect(pendingMarkup).toContain("Approve");
    expect(pendingMarkup).toContain("Not now");

    const reply = message({ id: "reply-1", sequence: 2, author: "user", content: "Later." });
    const staleMarkup = renderToStaticMarkup(createElement(CompanionTopicCard, {
      group: groupCompanionTopics([proposal])[0]!, messages: [reply, proposal],
      pendingProposalId: null, actionableSuggestionId: null, busy: false, respond, acceptSuggestion,
    }));
    expect(staleMarkup).not.toContain("Approval requested");
    expect(staleMarkup).not.toContain("Proposal actions");
    expect(staleMarkup).toContain("Superseded");
  });

  it("hoists a pending proposal beneath a newer same-topic status update", () => {
    const proposal = message({ id: "proposal-1", sequence: 1, kind: "proposal", refs: { taskId: "task-1" }, content: "Approve the merge?" });
    const update = message({ id: "update-1", sequence: 2, kind: "update", refs: { taskId: "task-1" }, content: "Builds are green." });
    const problem = message({ id: "problem-1", sequence: 3, kind: "problem", refs: { taskId: "task-1" }, content: "Review age could not be verified." });
    const thread = [problem, update, proposal];
    const markup = renderToStaticMarkup(createElement(CompanionTopicCard, {
      group: groupCompanionTopics(thread)[0]!, messages: thread,
      pendingProposalId: proposal.id, actionableSuggestionId: null, busy: false,
      respond: () => undefined, acceptSuggestion: () => undefined,
    }));
    expect(markup).toContain("Review age could not be verified.");
    expect(markup).toContain("Evidence problem");
    expect(markup).toContain("ap-msg-open-question");
    expect(markup).toContain("Approval requested");
    expect(markup).toContain("Approve the merge?");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Not now");
    expect(markup).toContain("1 earlier update");
    expect(markup).toContain("Builds are green.");
  });

  it("renders the newest update in full and earlier ones behind a disclosure", () => {
    const older = message({ id: "m1", sequence: 1, refs: { taskId: "task-1" }, content: "Builds are green." });
    const newer = message({ id: "m2", sequence: 2, kind: "proposal", refs: { taskId: "task-1" }, content: "Approve the merge?" });
    const markup = renderToStaticMarkup(createElement(CompanionTopicCard, {
      group: groupCompanionTopics([newer, older])[0]!, messages: [newer, older],
      pendingProposalId: newer.id, actionableSuggestionId: null, busy: false, respond, acceptSuggestion,
    }));
    expect(markup).toContain("Approve the merge?");
    expect(markup).toContain("1 earlier update");
    expect(markup).toContain("Builds are green.");
    expect(markup).toContain("<details");
  });

  it("states how many exact repeats were hidden", () => {
    const first = message({ id: "m1", sequence: 1, content: "Reminder: review is waiting." });
    const second = message({ id: "m2", sequence: 2, content: "Reminder: review is waiting." });
    const markup = renderToStaticMarkup(createElement(CompanionTopicCard, {
      group: groupCompanionTopics([second, first])[0]!, messages: [second, first],
      pendingProposalId: null, actionableSuggestionId: null, busy: false, respond, acceptSuggestion,
    }));
    expect(markup.match(/Reminder: review is waiting\./g)).toHaveLength(1);
    expect(markup).toContain("Repeated 2×");
  });

  it("offers accept only on the actionable suggestion", () => {
    const suggestion = message({ id: "s1", sequence: 1, kind: "suggestion", content: "Consider closing it." });
    const markup = renderToStaticMarkup(createElement(CompanionTopicCard, {
      group: groupCompanionTopics([suggestion])[0]!, messages: [suggestion],
      pendingProposalId: null, actionableSuggestionId: suggestion.id, busy: false, respond, acceptSuggestion,
    }));
    expect(markup).toContain("Accept suggestion");
  });
});

describe("Playbook current-state strip", () => {
  const playbook = {
    projectId: "project-1", revision: 1, activePipelineName: "Delivery",
    milestones: [
      { id: "ms-1", title: "Build green", gate: "automatic", routineId: "routine-1", retryDelaySeconds: 600, completeWhen: "CI green", whileWaiting: { mode: "off", instructions: "" }, workerId: "worker-1", approver: null },
      { id: "ms-2", title: "Review approved", gate: "automatic", routineId: "routine-2", retryDelaySeconds: 600, completeWhen: "Approved", whileWaiting: { mode: "off", instructions: "" }, workerId: "worker-1", approver: null },
    ],
    savedPipelines: [], updatedAtEpochMs: 1,
  } as PlaybookDto;
  const runtime = {
    activePipelineName: "Delivery", processingTaskId: "task-9",
    steps: [
      { milestoneId: "ms-1", routineId: "routine-1", waitingTaskIds: ["task-1", "task-2"], progress: [], nextAttemptAtEpochMs: 2000 },
      { milestoneId: "ms-2", routineId: "routine-2", waitingTaskIds: [], progress: [], nextAttemptAtEpochMs: 1000 },
    ],
    doneTaskIds: ["task-0"], stateRevision: 1,
  } as PlaybookRuntimeResult;

  it("summarizes the generated projections instead of chat prose", () => {
    expect(playbookStateSummary(null, runtime)).toBeNull();
    expect(playbookStateSummary({ ...playbook, milestones: [] }, runtime)).toBeNull();
    expect(playbookStateSummary(playbook, runtime)).toEqual({
      pipelineName: "Delivery",
      steps: [
        { milestoneId: "ms-1", title: "Build green", waitingCount: 2 },
        { milestoneId: "ms-2", title: "Review approved", waitingCount: 0 },
      ],
      doneCount: 1,
      processing: true,
      nextAttemptAtEpochMs: 1000,
    });
  });

  it("stays honest when the runtime projection has not loaded", () => {
    expect(playbookStateSummary(playbook, null)).toEqual({
      pipelineName: "Delivery",
      steps: [
        { milestoneId: "ms-1", title: "Build green", waitingCount: 0 },
        { milestoneId: "ms-2", title: "Review approved", waitingCount: 0 },
      ],
      doneCount: 0,
      processing: false,
      nextAttemptAtEpochMs: null,
    });
  });

  it("renders steps, waiting counts, and done count compactly", () => {
    const summary = playbookStateSummary(playbook, runtime)!;
    const markup = renderToStaticMarkup(createElement(PlaybookStateStrip, { summary }));
    expect(markup).toContain("Delivery");
    expect(markup).toContain("Build green · 2");
    expect(markup).toContain("Review approved");
    expect(markup).toContain("Done · 1");
    expect(markup).toContain("Steward is handling a step now");
    expect(markup).toContain("Current Playbook state");
  });
});
