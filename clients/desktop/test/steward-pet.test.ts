import { describe, expect, it } from "vitest";
import type { CompanionMessageDto } from "@termloop/contract/current";
import {
  STEWARD_PET_ACTIVITY_WINDOW_MS,
  latestStewardPetUtterance,
  stewardPetBubbleAlignment,
  stewardPetBubbleDismissMs,
  stewardPetBubbleHolds,
  stewardPetBubblePlacement,
  stewardPetClampPosition,
  stewardPetFace,
  stewardPetGazeOffset,
  stewardPetNearestCorner,
  stewardPetPendingUserMessage,
  stewardPetRoutesToPlaybookSetup,
  stewardPetSpeaks,
  stewardPetSignal,
  stewardPetState,
  stewardPetStatusLabel,
  stewardPetTicker,
  stewardPetUtteranceFromMessages,
  stewardPetUtteranceHolds,
  type StewardPetSignal,
  type StewardPetState,
  type StewardPetUtterance,
  type StewardPetUtteranceKind,
} from "../src/renderer/ui/StewardPet.js";

const NOW = 1_700_000_000_000;

function transcriptMessage(overrides: Partial<CompanionMessageDto> = {}): CompanionMessageDto {
  return {
    id: "message-1",
    projectId: "project-1",
    sequence: 1,
    author: "steward",
    kind: "reply",
    content: "Ready.",
    createdAtEpochMs: NOW,
    ...overrides,
  };
}

function signal(overrides: Partial<StewardPetSignal> = {}): StewardPetSignal {
  return {
    enabled: true,
    executorRunning: true,
    executorStatus: null,
    lastActivityAtEpochMs: null,
    activeCommandLabel: null,
    pendingProposal: false,
    problem: false,
    ...overrides,
  };
}

describe("Steward pet first-run routing", () => {
  it("routes to Playbook setup only while the Steward is off and no Playbook exists", () => {
    expect(stewardPetRoutesToPlaybookSetup(false, true)).toBe(true);
    // A Playbook already exists: the ordinary enable switch stays.
    expect(stewardPetRoutesToPlaybookSetup(false, false)).toBe(false);
    // An enabled Steward is never rerouted, whatever the Playbook read said.
    expect(stewardPetRoutesToPlaybookSetup(true, true)).toBe(false);
    expect(stewardPetRoutesToPlaybookSetup(true, false)).toBe(false);
  });
});

describe("Steward pet state derives from observed signals", () => {
  it("sleeps when the Steward is not enabled, whatever else is true", () => {
    expect(stewardPetState(signal({
      enabled: false, executorRunning: true, problem: true, pendingProposal: true, activeCommandLabel: "task_create",
    }), NOW)).toBe("asleep");
  });

  it("reports a stopped executor rather than inventing activity", () => {
    expect(stewardPetState(signal({
      executorRunning: false, activeCommandLabel: "task_create", lastActivityAtEpochMs: NOW,
    }), NOW)).toBe("gone");
  });

  it("ranks an unread problem above a pending proposal", () => {
    expect(stewardPetState(signal({ problem: true, pendingProposal: true }), NOW)).toBe("alert");
  });

  it("ranks observed in-flight work above an older pending proposal", () => {
    expect(stewardPetState(signal({ pendingProposal: true, activeCommandLabel: "task_agent_launch" }), NOW)).toBe("working");
    expect(stewardPetState(signal({ pendingProposal: true, executorStatus: "working" }), NOW)).toBe("thinking");
  });

  it("shows work while a named command is in flight", () => {
    expect(stewardPetState(signal({ activeCommandLabel: "task_agent_launch", lastActivityAtEpochMs: NOW }), NOW)).toBe("working");
  });

  it("uses the sidebar's structured provider status as the activity source", () => {
    expect(stewardPetState(signal({ executorStatus: "working" }), NOW)).toBe("thinking");
    expect(stewardPetState(signal({ executorStatus: "idle" }), NOW)).toBe("idle");
    expect(stewardPetState(signal({ executorStatus: "awaitingInput" }), NOW)).toBe("asking");
  });

  it("falls back to recent executor PTY bytes when structured status is unavailable", () => {
    expect(stewardPetState(signal({ executorStatus: "unknown", lastActivityAtEpochMs: NOW }), NOW)).toBe("thinking");
    expect(stewardPetState(signal({ executorStatus: null, lastActivityAtEpochMs: NOW }), NOW)).toBe("thinking");
    expect(stewardPetState(signal({ executorStatus: "idle", lastActivityAtEpochMs: NOW }), NOW)).toBe("idle");
    expect(stewardPetState(signal({ lastActivityAtEpochMs: NOW - STEWARD_PET_ACTIVITY_WINDOW_MS - 1 }), NOW)).toBe("idle");
  });
});

describe("Steward pet signal derivation from client projections", () => {
  const running = [{ id: "session-1", lifecycle_state: "running" }];

  it("reads the executor by the Steward's own recorded Session id", () => {
    const derived = stewardPetSignal({ enabled: true, executorSessionId: "session-1" }, running, []);
    expect(derived.executorRunning).toBe(true);
    expect(derived.enabled).toBe(true);
  });

  it("does not treat an unrelated running Session as the executor", () => {
    const derived = stewardPetSignal({ enabled: true, executorSessionId: "session-2" }, running, []);
    expect(derived.executorRunning).toBe(false);
    expect(stewardPetState(derived, NOW)).toBe("gone");
  });

  it("treats a missing Steward configuration as disabled rather than absent", () => {
    expect(stewardPetState(stewardPetSignal(null, running, []), NOW)).toBe("asleep");
  });

  it("raises a problem only from a problem report", () => {
    expect(stewardPetSignal({ enabled: true, executorSessionId: "session-1" }, running, [{ kind: "update" }]).problem).toBe(false);
    expect(stewardPetSignal({ enabled: true, executorSessionId: "session-1" }, running, [{ kind: "problem" }]).problem).toBe(true);
  });

  it("stays inert on telemetry the daemon does not project yet", () => {
    const derived = stewardPetSignal({ enabled: true, executorSessionId: "session-1" }, running, []);
    expect(derived.lastActivityAtEpochMs).toBeNull();
    expect(derived.activeCommandLabel).toBeNull();
    expect(derived.pendingProposal).toBe(false);
    expect(derived.executorStatus).toBeNull();
    expect(stewardPetState(derived, NOW)).toBe("idle");
  });

  it("carries supplied telemetry straight through once it exists", () => {
    const derived = stewardPetSignal({ enabled: true, executorSessionId: "session-1" }, running, [], {
      lastActivityAtEpochMs: NOW, activeCommandLabel: "task_agent_launch", pendingProposal: false,
    });
    expect(stewardPetState(derived, NOW)).toBe("working");
  });

  it("resolves executor activity from the same Agent status used by the sidebar", () => {
    const derived = stewardPetSignal(
      { enabled: true, executorSessionId: "session-1" },
      running,
      [],
      undefined,
      [{ sessionId: "session-1", status: "working" }],
    );
    expect(derived.executorStatus).toBe("working");
    expect(stewardPetState(derived, NOW)).toBe("thinking");
  });
});

describe("Steward pet face and status copy", () => {
  const states: StewardPetState[] = ["idle", "thinking", "working", "asking", "alert", "asleep", "gone"];

  it("gives every state a distinct pair of eyes and a status label", () => {
    const eyes = states.map((state) => stewardPetFace(state).eyes);
    expect(new Set(eyes).size).toBe(states.length);
    for (const state of states) expect(stewardPetStatusLabel(state).length).toBeGreaterThan(0);
  });

  it("names the in-flight command instead of a generic label", () => {
    expect(stewardPetTicker("working", "task_worktree_provision")).toBe("task_worktree_provision");
    expect(stewardPetTicker("working", null)).toBe("working");
    expect(stewardPetTicker("idle", null)).toBe("");
    expect(stewardPetTicker("gone", null)).toBe("needs restart");
  });
});

describe("Steward pet idle gaze", () => {
  it("turns toward the pointer and clamps at the edge of its range", () => {
    const bounds = { left: 100, top: 50, width: 40, height: 40 };
    expect(stewardPetGazeOffset({ x: 120, y: 70 }, bounds)).toEqual({ x: 0, y: 0 });
    expect(stewardPetGazeOffset({ x: -100, y: 70 }, bounds)).toEqual({ x: -2, y: 0 });
    expect(stewardPetGazeOffset({ x: 340, y: 70 }, bounds)).toEqual({ x: 2, y: 0 });
  });
});

describe("Steward pet bubble policy", () => {
  const kinds: StewardPetUtteranceKind[] = ["reply", "update", "attention", "suggestion", "action", "proposal", "problem", "acceptance", "approval", "decline"];

  it("holds anything waiting on the user and expires ordinary notifications", () => {
    expect(stewardPetBubbleHolds("proposal")).toBe(true);
    expect(stewardPetBubbleHolds("suggestion")).toBe(true);
    expect(stewardPetBubbleHolds("problem")).toBe(true);
    expect(stewardPetBubbleHolds("attention")).toBe(true);
    expect(stewardPetBubbleHolds("reply")).toBe(false);
    expect(stewardPetBubbleHolds("update")).toBe(false);
    for (const kind of kinds) {
      const timeout = stewardPetBubbleDismissMs(kind);
      if (stewardPetBubbleHolds(kind)) expect(timeout).toBeNull();
      else expect(timeout).toBeGreaterThan(0);
    }
  });
});

describe("Steward pet chat bubble projection", () => {
  it("shows the newest observed Steward message regardless of page ordering", () => {
    expect(stewardPetUtteranceFromMessages([
      transcriptMessage({ id: "message-2", sequence: 2, kind: "action", content: "Created the Task." }),
      transcriptMessage({ id: "message-1", sequence: 1, author: "user", content: "Please create it." }),
    ])).toMatchObject({
      id: "message-2", kind: "action", text: "Created the Task.", badgeLabel: "Completed", badgeTone: "done",
    });
  });

  it("closes an older Steward bubble after a newer user reply", () => {
    expect(stewardPetUtteranceFromMessages([
      transcriptMessage({ id: "message-1", sequence: 1, kind: "proposal", content: "Shall I create it?" }),
      transcriptMessage({ id: "message-2", sequence: 2, author: "user", content: "Not now." }),
    ])).toBeNull();
  });

  it("keeps the latest Steward line available when notifications are opened explicitly", () => {
    expect(latestStewardPetUtterance([
      transcriptMessage({ id: "message-1", sequence: 1, kind: "suggestion", content: "I found a cleanup." }),
      transcriptMessage({ id: "message-2", sequence: 2, author: "user", content: "Tell me more." }),
    ])).toMatchObject({
      id: "message-1",
      kind: "suggestion",
      text: "I found a cleanup.",
      badgeLabel: "Suggestion · superseded",
      interaction: null,
    });
  });

  it("keeps an open proposal actionable beneath a newer status notification", () => {
    const utterance = stewardPetUtteranceFromMessages([
      transcriptMessage({ id: "status-2", sequence: 2, kind: "update", content: "The build is green." }),
      transcriptMessage({ id: "proposal-1", sequence: 1, kind: "proposal", content: "Approve the release?" }),
    ]);
    expect(utterance).toMatchObject({
      id: "status-2",
      kind: "update",
      badgeLabel: "Update",
      interaction: {
        id: "proposal-1",
        kind: "proposal",
        text: "Approve the release?",
        badgeLabel: "Approval requested",
      },
    });
    expect(stewardPetUtteranceHolds(utterance!)).toBe(true);
  });

  it("shows typed action receipts as resolved notifications without stale controls", () => {
    const accepted = stewardPetUtteranceFromMessages([
      transcriptMessage({ id: "receipt-2", sequence: 2, author: "user", kind: "acceptance", content: "Accepted. Proceed with this suggestion." }),
      transcriptMessage({ id: "suggestion-1", sequence: 1, kind: "suggestion", content: "Prepare the handoff." }),
    ]);
    expect(accepted).toMatchObject({
      id: "receipt-2",
      kind: "acceptance",
      badgeLabel: "Accepted",
      interaction: null,
    });
    expect(stewardPetUtteranceHolds(accepted!)).toBe(false);
  });

  it("uses only a newest user line as the pending thinking context", () => {
    expect(stewardPetPendingUserMessage([
      transcriptMessage({ id: "message-2", sequence: 2, author: "user", content: "Can you check the retry?" }),
      transcriptMessage({ id: "message-1", sequence: 1, content: "Ready." }),
    ])).toBe("Can you check the retry?");
    expect(stewardPetPendingUserMessage([
      transcriptMessage({ id: "message-2", sequence: 2, content: "Checked it." }),
      transcriptMessage({ id: "message-1", sequence: 1, author: "user", content: "Can you check the retry?" }),
    ])).toBeNull();
  });
});

describe("Steward pet interruption rules", () => {
  function utterance(kind: StewardPetUtteranceKind): StewardPetUtterance {
    return { id: "utterance-1", kind, text: "Two reports name the same staging failure." };
  }

  it("stays silent with nothing to say", () => {
    expect(stewardPetSpeaks(null, { muted: false, userBusy: false })).toBe(false);
  });

  it("never opens a bubble while muted, including for a proposal", () => {
    expect(stewardPetSpeaks(utterance("reply"), { muted: true, userBusy: false })).toBe(false);
    expect(stewardPetSpeaks(utterance("proposal"), { muted: true, userBusy: false })).toBe(false);
  });

  it("defers ordinary speech while the user types but still surfaces what waits on them", () => {
    expect(stewardPetSpeaks(utterance("reply"), { muted: false, userBusy: true })).toBe(false);
    expect(stewardPetSpeaks(utterance("suggestion"), { muted: false, userBusy: true })).toBe(true);
    expect(stewardPetSpeaks(utterance("proposal"), { muted: false, userBusy: true })).toBe(true);
    expect(stewardPetSpeaks(utterance("problem"), { muted: false, userBusy: true })).toBe(true);
  });

  it("speaks normally when nothing is blocking it", () => {
    expect(stewardPetSpeaks(utterance("reply"), { muted: false, userBusy: false })).toBe(true);
  });
});

describe("Steward pet free placement", () => {
  const bounds = { width: 800, height: 600 };

  it("keeps a freely dragged position inside the stage", () => {
    const pet = { width: 46, height: 60 };
    expect(stewardPetClampPosition({ x: 320, y: 240 }, bounds, pet)).toEqual({ x: 320, y: 240 });
    expect(stewardPetClampPosition({ x: -20, y: -10 }, bounds, pet)).toEqual({ x: 0, y: 0 });
    expect(stewardPetClampPosition({ x: 900, y: 700 }, bounds, pet)).toEqual({ x: 754, y: 540 });
  });

  it("uses the nearest quadrant only to place the speech bubble away from an edge", () => {
    expect(stewardPetNearestCorner({ x: 10, y: 590 }, bounds)).toBe("bottomLeft");
    expect(stewardPetNearestCorner({ x: 790, y: 590 }, bounds)).toBe("bottomRight");
    expect(stewardPetNearestCorner({ x: 10, y: 10 }, bounds)).toBe("topLeft");
    expect(stewardPetNearestCorner({ x: 790, y: 10 }, bounds)).toBe("topRight");
  });

  it("keeps the exact centre out of the bottom half", () => {
    expect(stewardPetNearestCorner({ x: 400, y: 300 }, bounds)).toBe("topLeft");
  });

  it("opens the bubble away from the nearest edge", () => {
    expect(stewardPetBubblePlacement("bottomLeft")).toBe("above");
    expect(stewardPetBubblePlacement("bottomRight")).toBe("above");
    expect(stewardPetBubblePlacement("topLeft")).toBe("below");
    expect(stewardPetBubblePlacement("topRight")).toBe("below");
    expect(stewardPetBubbleAlignment("bottomLeft")).toBe("left");
    expect(stewardPetBubbleAlignment("topLeft")).toBe("left");
    expect(stewardPetBubbleAlignment("bottomRight")).toBe("right");
    expect(stewardPetBubbleAlignment("topRight")).toBe("right");
  });
});
