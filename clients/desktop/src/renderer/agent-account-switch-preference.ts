/// Client-local choice for what happens to running Claude or Codex Sessions
/// after the default account changes. Core owns none of it; a blocked store
/// only means the user is asked again.
const AGENT_ACCOUNT_SWITCH_KEY = "termloop.agentAccountSwitch.v1";

const POLICIES = ["ask", "restart", "keep"] as const;
export type AgentAccountSwitchPolicy = typeof POLICIES[number];

export function readAgentAccountSwitchPolicy(storage?: Pick<Storage, "getItem">): AgentAccountSwitchPolicy {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const value = source?.getItem(AGENT_ACCOUNT_SWITCH_KEY);
    return POLICIES.find((policy) => policy === value) ?? "ask";
  } catch {
    return "ask";
  }
}

export function writeAgentAccountSwitchPolicy(policy: AgentAccountSwitchPolicy, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(AGENT_ACCOUNT_SWITCH_KEY, policy);
  } catch {
    // An unavailable preference store must not prevent switching accounts.
  }
}

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
