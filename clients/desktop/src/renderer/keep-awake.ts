import type { KeepAwakeLimitation, KeepAwakeMode, KeepAwakeStatusResult } from "@termloop/contract/current";

export const KEEP_AWAKE_MODES = ["off", "whileAgentsRun", "always"] as const satisfies readonly KeepAwakeMode[];
export const KEEP_AWAKE_DURATIONS = [900, 1800, 3600, 7200, 14400, 28800, 604800] as const;

export function keepAwakeModeLabel(mode: KeepAwakeMode): string {
  switch (mode) {
    case "off": return "Off";
    case "whileAgentsRun": return "While agents run";
    case "always": return "Always";
  }
}

export function keepAwakeModeHint(mode: KeepAwakeMode): string {
  switch (mode) {
    case "off": return "This computer sleeps on its usual schedule.";
    case "whileAgentsRun": return "Held only while at least one agent process is alive.";
    case "always": return "Held for as long as TermLoop is running.";
  }
}

/**
 * One honest line about what is happening right now. It never promises that
 * the computer cannot sleep: the daemon reports the hold it took, and the
 * limitations list carries what the OS can still override.
 */
export function keepAwakeSummary(status: KeepAwakeStatusResult): string {
  switch (status.state) {
    case "unsupported": return "Not available on this system.";
    case "failed": return "The system refused the request.";
    case "active": return status.expiresAtEpochMs !== null
      ? "Holding this computer awake until the timer ends."
      : status.mode === "always"
      ? "Holding this computer awake."
      : `Holding this computer awake for ${agentCount(status.eligibleAgentCount)}.`;
    case "inactive": return status.reason === "modeOff"
      ? "Not holding this computer awake."
      : status.reason === "timerExpired"
      ? "The keep-awake timer has finished."
      : "Waiting for an agent to start.";
  }
}

/** Whether the trigger should read as engaged. */
export function keepAwakeIsEngaged(status: KeepAwakeStatusResult | undefined): boolean {
  return status?.state === "active";
}

/** Whether the current selection cannot take effect and should be flagged. */
export function keepAwakeIsBlocked(status: KeepAwakeStatusResult | undefined): boolean {
  return status?.state === "unsupported" || status?.state === "failed";
}

export function keepAwakeLimitationLabel(limitation: KeepAwakeLimitation): string {
  switch (limitation) {
    case "lidClose": return "closing the lid";
    case "userInitiatedSleep": return "sleeping it yourself";
    case "lowBattery": return "critically low battery";
    case "thermalEmergency": return "a thermal emergency";
  }
}

/**
 * Renders the limitations as one sentence. Returns undefined when the host
 * reported none, so the UI shows nothing rather than an empty caveat.
 */
export function keepAwakeLimitationSentence(limitations: readonly KeepAwakeLimitation[]): string | undefined {
  if (limitations.length === 0) return undefined;
  const parts = limitations.map(keepAwakeLimitationLabel);
  const listed = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `It can still sleep from ${listed}.`;
}

export function keepAwakeCountdown(expiresAtEpochMs: number | null, nowEpochMs: number): string | undefined {
  if (expiresAtEpochMs === null || expiresAtEpochMs <= nowEpochMs) return undefined;
  const totalMinutes = Math.ceil((expiresAtEpochMs - nowEpochMs) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0
    ? `${hours} hr ${String(minutes).padStart(2, "0")} min`
    : `${minutes} min`;
}

export function keepAwakeDurationLabel(seconds: number): string {
  if (seconds < 3600) return `${seconds / 60} minutes`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  return `${Math.floor(seconds / 3600)} hours`;
}

function agentCount(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}
