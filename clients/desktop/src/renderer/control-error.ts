/// Electron rejects a preload call as
/// `Error invoking remote method '<channel>': <ErrorName>: <message>`. The
/// channel and the error class are transport detail; the rail shows the message
/// the daemon actually sent.
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_CLASS = /^[A-Za-z]+Error:\s*/;

export function controlErrorMessage(error: unknown): string {
  const message = rawErrorMessage(error);
  const unwrapped = message.replace(IPC_WRAPPER, "");
  return unwrapped === message ? message : unwrapped.replace(ERROR_CLASS, "");
}

/// Dismissing a Session the daemon has already forgotten is not a failure the
/// user can act on — the row is stale and the refresh that follows removes it.
export function sessionDismissErrorMessage(error: unknown): string {
  const message = controlErrorMessage(error);
  return /record not found/i.test(message) ? "That Session is no longer running." : message;
}

export function agentForkErrorMessage(error: unknown): string {
  const reason = forkUnavailableReason(error);
  const messages: Record<string, string> = {
    sourceNotRunning: "This source Agent is no longer available. Refresh the Session list and retry the fork.",
    resumeRefMissing: "This Agent has no verified provider conversation to fork.",
    capabilityUnavailable: "The installed provider does not support conversation forks.",
    cwdUnavailable: "The Agent's working directory or managed worktree is unavailable.",
    launchReserved: "Cleanup or repair currently reserves this Agent's working directory.",
    providerRejected: "The provider rejected this conversation fork. Check its local conversation history and authentication, then retry.",
    providerHistoryDamaged: "This provider conversation history is damaged. TermLoop stopped before writing to it again; repair or recover this thread, then retry the fork.",
    conversationUnconfirmed: "The fork started, but its exact provider conversation could not be confirmed. The source Agent was left unchanged; retry or inspect the provider thread.",
    startupExited: "The fork process exited before it became ready. The source conversation may be unavailable or damaged; retry another conversation, or inspect this provider thread before retrying.",
    startupTimedOut: "The forked Agent did not become ready before the startup timeout. Retry the fork.",
    runtimeConflict: "Another runtime conflicted with this conversation fork. Wait for the current operation to finish, then retry.",
  };
  return reason ? messages[reason] ?? controlErrorMessage(error) : controlErrorMessage(error);
}

export function agentForkRequiresProviderHistoryRepair(error: unknown): boolean {
  return forkUnavailableReason(error) === "providerHistoryDamaged";
}

export function sessionRequiresProviderHistoryRepair(session: {
  resume_failure_reason?: string | null;
}): boolean {
  return session.resume_failure_reason === "providerHistoryDamaged";
}

export function providerHistoryRepairErrorMessage(error: unknown): string {
  const reason = providerHistoryRepairUnavailableReason(error);
  const messages: Record<string, string> = {
    sessionRunning: "The Agent is still running. Stop it before repairing its provider history.",
    providerUnsupported: "Provider history repair is available only for supported Codex conversations.",
    resumeRefMissing: "This Session has no verified Codex conversation identity to repair.",
    historyUnavailable: "TermLoop could not safely locate or read this provider history.",
    damageUnrecognized: "The history does not match the known restart damage pattern, so TermLoop left it unchanged.",
    mutationFailed: "TermLoop could not safely create the backup and replace the provider history.",
    verificationFailed: "The repair could not be verified with a fresh provider runtime. The backup was retained if a replacement occurred.",
    recoveryAttention: "Runtime or file ownership could not be proven after repair. Inspect the provider history and retained backup before retrying.",
    runtimeConflict: "Another lifecycle operation owns this Session. Wait for it to finish and retry Repair.",
  };
  return reason ? messages[reason] ?? controlErrorMessage(error) : controlErrorMessage(error);
}

function forkUnavailableReason(error: unknown): string | undefined {
  if (typeof error !== "object" || !error || !("details" in error)) return undefined;
  const details = (error as { details?: { kind?: unknown; reason?: unknown } }).details;
  return details?.kind === "agentForkUnavailable" && typeof details.reason === "string"
    ? details.reason
    : undefined;
}

function providerHistoryRepairUnavailableReason(error: unknown): string | undefined {
  if (typeof error !== "object" || !error || !("details" in error)) return undefined;
  const details = (error as { details?: { kind?: unknown; reason?: unknown } }).details;
  return details?.kind === "providerHistoryRepairUnavailable" && typeof details.reason === "string"
    ? details.reason
    : undefined;
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

export function projectDeleteErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "details" in error) {
    const details = (error as { details?: { blocker?: unknown } }).details;
    if (details?.blocker === "worktrees") return "Clean up this Project's Task worktrees first.";
  }
  return controlErrorMessage(error);
}
