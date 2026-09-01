import type { SessionActionsPort } from "@/application/ports";
import type { SessionRecoveryAction } from "@/presentation/session-actions-presentation";

/// Executes the same recovery chain as desktop's row-level Fix action. History
/// repair is not a successful recovery by itself: only a subsequent restart
/// makes the Session usable again.
export async function executeSessionRecovery(
  actions: Pick<SessionActionsPort, "repairProviderHistory" | "restart">,
  connectionId: string,
  sessionId: string,
  recovery: SessionRecoveryAction,
): Promise<void> {
  if (recovery.kind === "repairAndRetry") {
    await actions.repairProviderHistory(connectionId, sessionId);
  }
  await actions.restart(connectionId, sessionId);
}
