import type { RoutineConfigurationDto, RoutineHealthDto } from "@termloop/contract/current";
import type { AgentStatus } from "../model.js";
import { generatedInputDeliveryPresentation } from "../session-presentation.js";
import type { GeneratedInputDeliveryLabel } from "../session-presentation.js";

export type AssistantStatusLabel =
  | "Off" | "Ready" | "Active" | "Idle" | "Checking" | "Waiting" | "Attention"
  | GeneratedInputDeliveryLabel;
export type AssistantStatusTone = "off" | "ready" | "checking" | "waiting" | "attention";

export type AssistantStatus = Readonly<{
  label: AssistantStatusLabel;
  tone: AssistantStatusTone;
  reason: string;
  nextAction: string;
  detail?: string;
}>;

export function persistentAssistantStatus(options: {
  enabled: boolean;
  running: boolean;
  restarting: boolean;
  active?: boolean;
  generatedInputDelivery?: AgentStatus["generatedInputDelivery"];
}): AssistantStatus {
  if (options.enabled && !options.running && !options.restarting) return {
    label: "Attention",
    tone: "attention",
    reason: "The assistant is enabled, but its Session is not running.",
    nextAction: "Restart it.",
  };
  if (!options.enabled) return {
    label: "Off",
    tone: "off",
    reason: "The assistant is turned off.",
    nextAction: "Turn it on when you want it available.",
  };
  if (options.restarting) return {
    label: "Checking",
    tone: "checking",
    reason: "TermLoop is restarting the assistant.",
    nextAction: "Wait for the new Session to become ready.",
  };
  const delivery = generatedInputDeliveryPresentation(options.generatedInputDelivery);
  if (delivery) return {
    label: delivery.state.label ?? "Attention",
    tone: delivery.state.tone === "busy" ? "checking" : "attention",
    reason: delivery.state.summary,
    nextAction: delivery.nextAction,
    detail: delivery.detail,
  };
  if (options.active) return {
    label: "Active",
    tone: "checking",
    reason: "The assistant is processing a turn now.",
    nextAction: "Open its Terminal to follow the work.",
  };
  return {
    label: "Idle",
    tone: "ready",
    reason: "The assistant is running and waiting for work.",
    nextAction: "Open its Terminal or wait for the next wake.",
  };
}

export function routineDisplayStatus(
  routine: Pick<RoutineConfigurationDto, "enabled" | "triggerMode">,
  health: Pick<RoutineHealthDto, "state" | "attentionMessage" | "pendingTrigger"> | undefined,
): AssistantStatus {
  if (health?.state === "attention") return {
    label: "Attention",
    tone: "attention",
    reason: health.attentionMessage?.trim() || "The Steward reported a problem while running this Routine.",
    nextAction: "Fix the reported problem, then restart the Steward.",
  };
  if (!routine.enabled) return {
    label: "Off",
    tone: "off",
    reason: "This Routine will not run.",
    nextAction: "Turn it on when you want the Steward to use it.",
  };
  if (health?.state === "checking") return {
    label: "Checking",
    tone: "checking",
    reason: "The Steward is checking the configured sources now.",
    nextAction: "Wait for this check to finish.",
  };
  if (health?.state === "overdue" || health?.pendingTrigger) return {
    label: "Waiting",
    tone: "waiting",
    reason: health.state === "overdue"
      ? "A due check has not completed yet."
      : "This Routine is waiting for its Steward assignment.",
    nextAction: "Restart the Steward if it does not recover.",
  };
  return {
    label: "Ready",
    tone: "ready",
    reason: routine.triggerMode === "onDemand"
      ? "This Routine is ready when a Task reaches its Playbook step."
      : "This Routine is ready for its next scheduled check.",
    nextAction: routine.triggerMode === "onDemand"
      ? "Wait for a Task at this step, or use Run now."
      : "Wait for the schedule, or use Run now.",
  };
}

export function statusExplanation(status: AssistantStatus): string {
  return `${status.reason} Next: ${status.nextAction}`;
}
