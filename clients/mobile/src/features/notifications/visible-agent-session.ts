/// The Agent Session whose screen is focused right now. An alert about the
/// terminal the user is already watching adds nothing, so it stays silent.
let visibleSessionId: string | undefined;

export function markAgentSessionVisible(sessionId: string): () => void {
  visibleSessionId = sessionId;
  return () => {
    if (visibleSessionId === sessionId) visibleSessionId = undefined;
  };
}

export function isAgentSessionVisible(sessionId: string | undefined): boolean {
  return sessionId !== undefined && sessionId === visibleSessionId;
}
