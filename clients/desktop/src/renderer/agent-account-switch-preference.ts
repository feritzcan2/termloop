/// Pure helpers for moving running Claude or Codex Sessions after the default
/// account changes. The user is asked every time; no choice is remembered.

/** Running Sessions of `agentId` still pinned to an account other than `accountId`. */
export function sessionsOnOtherAccounts<T extends { id: string; kind: string; lifecycle_state: string; process: { agent_id?: string | null }; agent_account_id?: string | null }>(sessions: readonly T[], agentId: string, accountId: string): T[] {
  return sessions.filter((session) => session.kind === "Agent"
    && session.process.agent_id === agentId
    && session.lifecycle_state === "running"
    && typeof session.agent_account_id === "string"
    && session.agent_account_id !== accountId);
}

/** A working Agent finishes its turn on the old account before it restarts. */
export function agentSessionBusy(status: string | undefined): boolean {
  return status === "working" || status === "compacting";
}
