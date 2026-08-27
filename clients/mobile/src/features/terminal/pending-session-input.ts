const MAX_PENDING_INPUTS = 8;

const pendingInputs = new Map<string, string>();

function key(connectionId: string, sessionId: string, runtimeEpoch: number): string {
  return `${connectionId}\u0000${sessionId}\u0000${runtimeEpoch}`;
}

/// Keeps a failed launch-time submission in memory only. It is scoped to the
/// exact Mac and runtime epoch, consumed once, and never placed in navigation
/// parameters or durable storage.
export function retainPendingSessionInput(
  connectionId: string,
  sessionId: string,
  runtimeEpoch: number,
  content: string,
): void {
  const scopedKey = key(connectionId, sessionId, runtimeEpoch);
  pendingInputs.delete(scopedKey);
  pendingInputs.set(scopedKey, content);
  while (pendingInputs.size > MAX_PENDING_INPUTS) {
    const oldest = pendingInputs.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingInputs.delete(oldest);
  }
}

export function takePendingSessionInput(
  connectionId: string,
  sessionId: string,
  runtimeEpoch: number,
): string | undefined {
  const scopedKey = key(connectionId, sessionId, runtimeEpoch);
  const content = pendingInputs.get(scopedKey);
  pendingInputs.delete(scopedKey);
  return content;
}
