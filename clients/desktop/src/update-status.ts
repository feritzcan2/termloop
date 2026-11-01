/// What the packaged updater is doing. Main owns the state machine; the renderer
/// only renders it and raises check or install intents.
export type UpdateStatus =
  | { state: "unsupported" }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "current" }
  | { state: "downloading"; version: string; percent: number | null }
  | { state: "ready"; version: string }
  | { state: "installing"; version: string }
  /**
   * `version` is null when the check itself failed, before any download.
   * `reason` is a bounded error code (never a URL or raw message), or null.
   */
  | { state: "failed"; version: string | null; reason: string | null };

const FAILURE_REASON = /^[A-Za-z0-9_:.-]{1,64}$/;

/// Keeps only a short error code, so no URL or raw network message crosses the bridge.
export function updateFailureReason(value: unknown): string | null {
  return typeof value === "string" && FAILURE_REASON.test(value) ? value : null;
}

export type UpdateSnapshot = { currentVersion: string; status: UpdateStatus };

export function parseUpdateStatus(value: unknown): UpdateStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { state?: unknown; version?: unknown; percent?: unknown; reason?: unknown };
  const version = typeof candidate.version === "string" ? candidate.version : undefined;
  switch (candidate.state) {
    case "unsupported":
    case "idle":
    case "checking":
    case "current":
      return { state: candidate.state };
    case "downloading":
      if (version === undefined) return undefined;
      return {
        state: "downloading",
        version,
        percent: typeof candidate.percent === "number" && Number.isFinite(candidate.percent) ? candidate.percent : null,
      };
    case "ready":
    case "installing":
      return version === undefined ? undefined : { state: candidate.state, version };
    case "failed":
      return { state: "failed", version: version ?? null, reason: updateFailureReason(candidate.reason) };
    default:
      return undefined;
  }
}
