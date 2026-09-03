const MOBILE_RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const MOBILE_APP_STATES = new Set(["active", "background", "inactive", "unknown", "extension"]);

export function createGatewayDiagnosticReporter(
  write,
  { now = Date.now, pid = process.pid } = {},
) {
  const startedAtEpochMs = now();
  let sequence = 0;
  return {
    report(area, event, details = {}) {
      const atEpochMs = now();
      try {
        write(JSON.stringify({
          atEpochMs,
          elapsedMs: Math.max(0, atEpochMs - startedAtEpochMs),
          sequence: ++sequence,
          pid,
          area,
          event,
          ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)),
        }));
      } catch {
        // Logging must never take the mobile gateway down.
      }
    },
  };
}

export function mobileDiagnosticContext(request) {
  return {
    mobileRunId: typeof request?.mobileRunId === "string" && MOBILE_RUN_ID.test(request.mobileRunId)
      ? request.mobileRunId
      : undefined,
    controlGeneration: Number.isSafeInteger(request?.controlGeneration)
      && request.controlGeneration >= 0
      ? request.controlGeneration
      : undefined,
    mobileAppState: typeof request?.mobileAppState === "string"
      && MOBILE_APP_STATES.has(request.mobileAppState)
      ? request.mobileAppState
      : undefined,
    foregroundRevision: Number.isSafeInteger(request?.foregroundRevision)
      && request.foregroundRevision >= 0
      ? request.foregroundRevision
      : undefined,
    backgroundDurationMs: Number.isSafeInteger(request?.backgroundDurationMs)
      && request.backgroundDurationMs >= 0
      && request.backgroundDurationMs <= 7 * 24 * 60 * 60 * 1_000
      ? request.backgroundDurationMs
      : undefined,
  };
}
