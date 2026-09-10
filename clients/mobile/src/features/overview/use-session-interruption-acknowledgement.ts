import type { AgentStatusDto } from "@termloop/contract/current";
import { useEffect, useMemo } from "react";

/// Retained native-stack routes must acknowledge on blur as well as unmount.
/// Track only observations rendered while focused, never a hidden route's updates.
export function useSessionInterruptionAcknowledgement(
  focused: boolean,
  connectionId: string | undefined,
  sessionId: string | undefined,
  status: AgentStatusDto | undefined,
  acknowledge: (connectionId: string, sessionId: string, observedAtEpochMs: number) => void,
) {
  const inspected = useMemo<{ status: AgentStatusDto | undefined }>(() => ({ status: undefined }), [connectionId, sessionId]);
  useEffect(() => {
    if (focused) inspected.status = status;
  }, [focused, inspected, status]);
  useEffect(() => {
    if (!focused || connectionId === undefined || sessionId === undefined) return;
    return () => {
      if (inspected.status?.status === "interrupted" && inspected.status.sessionId === sessionId) {
        acknowledge(connectionId, sessionId, inspected.status.observedAtEpochMs);
      }
    };
  }, [focused, connectionId, sessionId, inspected, acknowledge]);
}
