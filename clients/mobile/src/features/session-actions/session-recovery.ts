import type { SessionActionsPort } from "@/application/ports";
import type { SessionRecoveryAction } from "@/presentation/session-actions-presentation";
import { mobileDiagnostics } from "../../platform/mobile-diagnostics";

const recoveries = new Map<string, Promise<void>>();

/// Executes the same recovery chain as desktop's row-level Fix action. History
/// repair is not a successful recovery by itself: only a freshly previewed resume
/// makes the Session usable again. Concurrent taps share one mutation chain.
export function executeSessionRecovery(
  actions: Pick<SessionActionsPort, "repairProviderHistory" | "retry">,
  connectionId: string,
  sessionId: string,
  recovery: SessionRecoveryAction,
): Promise<void> {
  const key = `${connectionId}\u0000${sessionId}`;
  const existing = recoveries.get(key);
  if (existing !== undefined) return existing;

  const operation = (async () => {
    mobileDiagnostics.report("control", "session_recovery_started", {
      connectionId,
      sessionId,
      reason: recovery.kind,
    });
    try {
      if (recovery.kind === "repairAndRetry") {
        await actions.repairProviderHistory(connectionId, sessionId);
        mobileDiagnostics.report("control", "session_history_repair_completed", {
          connectionId,
          sessionId,
        });
      }
      await actions.retry(connectionId, sessionId);
      mobileDiagnostics.report("control", "session_recovery_completed", {
        connectionId,
        sessionId,
        reason: recovery.kind,
      });
    } catch (cause: unknown) {
      mobileDiagnostics.report("control", "session_recovery_failed", {
        connectionId,
        sessionId,
        reason: recovery.kind,
        causeType: cause instanceof Error ? cause.name : typeof cause,
        errorCode: errorCode(cause),
      });
      throw cause;
    }
  })().finally(() => {
    if (recoveries.get(key) === operation) recoveries.delete(key);
  });
  recoveries.set(key, operation);
  return operation;
}

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}
