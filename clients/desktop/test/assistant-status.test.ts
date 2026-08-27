import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../src/renderer/model.js";
import {
  persistentAssistantStatus,
  routineDisplayStatus,
  statusExplanation,
} from "../src/renderer/ui/assistant-status.js";

const routine = (enabled = true, triggerMode: "schedule" | "onDemand" = "schedule") => ({ enabled, triggerMode });
const health = (
  state: "idle" | "checking" | "overdue" | "attention",
  pendingTrigger = false,
  attentionMessage: string | null = null,
) => ({ state, pendingTrigger, attentionMessage });

function generatedInputDelivery(
  state: NonNullable<AgentStatus["generatedInputDelivery"]>["state"],
  failure: NonNullable<AgentStatus["generatedInputDelivery"]>["failure"],
  pasteReceipted = true,
  submitAttempts = 0,
): NonNullable<AgentStatus["generatedInputDelivery"]> {
  return {
    state,
    failure,
    originalFailure: failure,
    cancelCause: null,
    cancelNotificationType: null,
    pasteReceipted,
    settlementEvidence: null,
    submitReceipted: false,
    submitAttempts,
    protocolReplyWaits: 0,
    userInputMutated: null,
    outputChunks: 0,
    synchronizedFrames: 0,
    composerRenders: 0,
    completedComposerFrames: 0,
    composerSurfaceFrames: 0,
    composerCursorMoved: false,
    templateRef: "builtin.worker.wake",
    templateVersion: 1,
  };
}

describe("assistant status language", () => {
  it("uses one stable vocabulary for persistent assistants", () => {
    expect(persistentAssistantStatus({ enabled: false, running: false, restarting: false }).label).toBe("Off");
    expect(persistentAssistantStatus({ enabled: true, running: true, restarting: false }).label).toBe("Idle");
    expect(persistentAssistantStatus({ enabled: true, running: true, restarting: false, active: true }).label).toBe("Active");
    expect(persistentAssistantStatus({ enabled: true, running: false, restarting: true }).label).toBe("Checking");
    expect(persistentAssistantStatus({ enabled: true, running: false, restarting: false }).label).toBe("Attention");
  });

  it("shows the exact generated-prompt failure on a running Worker instead of Idle", () => {
    expect(persistentAssistantStatus({
      enabled: true,
      running: true,
      restarting: false,
      generatedInputDelivery: generatedInputDelivery("blocked", "outputDidNotSettle"),
    })).toMatchObject({
      label: "Press Enter",
      tone: "attention",
      detail: "terminal did not settle",
    });
    expect(persistentAssistantStatus({
      enabled: true,
      running: true,
      restarting: false,
      generatedInputDelivery: generatedInputDelivery("blocked", "composerUnavailable", false),
    })).toMatchObject({
      label: "Waiting to submit",
      detail: "agent composer unavailable",
    });
    expect(persistentAssistantStatus({
      enabled: true,
      running: true,
      restarting: false,
      generatedInputDelivery: generatedInputDelivery("failed", "submitWriteFailed"),
    })).toMatchObject({
      label: "Prompt failed",
      detail: "Enter write failed",
    });
    expect(persistentAssistantStatus({
      enabled: true,
      running: true,
      restarting: false,
      generatedInputDelivery: generatedInputDelivery("stalled", "providerAckMissing", true, 2),
    })).toMatchObject({
      label: "Prompt unconfirmed",
      detail: "provider did not confirm after 2 Enter attempts",
    });
  });

  it("uses the same vocabulary and urgency order for Routines", () => {
    expect(routineDisplayStatus(routine(false), health("idle")).label).toBe("Off");
    expect(routineDisplayStatus(routine(), health("idle")).label).toBe("Ready");
    expect(routineDisplayStatus(routine(), health("checking")).label).toBe("Checking");
    expect(routineDisplayStatus(routine(), health("idle", true)).label).toBe("Waiting");
    expect(routineDisplayStatus(routine(), health("overdue")).label).toBe("Waiting");
    expect(routineDisplayStatus(routine(), health("attention", false, "Jira is unavailable."))).toMatchObject({
      label: "Attention",
      reason: "Jira is unavailable.",
    });
  });

  it("always explains why the status exists and what to do next", () => {
    const status = routineDisplayStatus(routine(), health("idle"));
    expect(status.reason).not.toBe("");
    expect(status.nextAction).not.toBe("");
    expect(statusExplanation(status)).toBe(`${status.reason} Next: ${status.nextAction}`);
  });
});
