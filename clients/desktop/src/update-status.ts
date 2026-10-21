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
  /** `version` is null when the check itself failed, before any download. */
  | { state: "failed"; version: string | null };

export type UpdateSnapshot = { currentVersion: string; status: UpdateStatus };

export function parseUpdateStatus(value: unknown): UpdateStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { state?: unknown; version?: unknown; percent?: unknown };
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
      return { state: "failed", version: version ?? null };
    default:
      return undefined;
  }
}
