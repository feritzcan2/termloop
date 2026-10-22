import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AgentAccountListResult, AgentAccountUsageDto } from "@termloop/contract/current";
import type { AgentStatus, Session } from "../model.js";
import {
  agentSessionBusy,
  readAgentAccountSwitchPolicy,
  sessionsOnOtherAccounts,
  writeAgentAccountSwitchPolicy,
  type AgentAccountSwitchPolicy,
} from "../agent-account-switch-preference.js";
import { identityLabel, UsageWindows, type AgentConnectionActions } from "./AgentConnectionsPanel.js";
import { Icon } from "./Icon.js";
import { SidebarFooterHoverCard } from "./SidebarFooterHoverCard.js";

const PROVIDERS = [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }] as const;
type ProviderId = typeof PROVIDERS[number]["id"];
type Pending = { agentId: ProviderId; accountId: string; accountName: string; sessionIds: string[] };

/**
 * Sidebar-footer switcher for the server's default Claude and Codex accounts.
 *
 * Switching changes only which account new Agents use. Running Sessions on
 * another account follow the remembered policy: ask, restart them on the new
 * account (a busy Agent finishes its turn first), or keep them as they are.
 */
export function AgentAccountSwitcher({ profileId, actions, sessions, agentStatuses, switchSession, openSettings, disabled = false }: {
  profileId: string;
  actions: AgentConnectionActions;
  sessions: readonly Session[];
  agentStatuses: readonly AgentStatus[];
  switchSession(sessionId: string, accountId: string): Promise<string | undefined>;
  openSettings(): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<AgentAccountListResult>();
  const [usage, setUsage] = useState<AgentAccountUsageDto[]>([]);
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [prompt, setPrompt] = useState<Pending>();
  const [remember, setRemember] = useState(false);
  const [waiting, setWaiting] = useState<ReadonlyMap<string, string>>(new Map());
  const rootRef = useRef<HTMLDivElement>(null);
  const hoverCardId = useId();

  const load = useCallback(() => {
    let cancelled = false;
    if (disabled) { setAccounts(undefined); return () => { cancelled = true; }; }
    actions.accounts(profileId)
      .then((value) => { if (!cancelled) { setAccounts(value); setFailure(undefined); } })
      .catch(() => { if (!cancelled) setFailure("Could not read this computer's agent accounts."); });
    actions.usage(profileId)
      .then((value) => { if (!cancelled) setUsage(value.accounts); })
      .catch(() => { if (!cancelled) setUsage([]); });
    return () => { cancelled = true; };
  }, [actions, disabled, profileId]);

  useEffect(() => load(), [load]);
  useEffect(() => { if (open) return load(); }, [load, open]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  const restart = useCallback((sessionId: string, accountId: string) => {
    switchSession(sessionId, accountId).then((error) => { if (error) setFailure(error); }).catch(() => setFailure("Could not move that Session to the new account."));
  }, [switchSession]);

  // Busy Agents keep the old account until their turn ends, then restart.
  useEffect(() => {
    if (waiting.size === 0) return;
    const statuses = new Map(agentStatuses.map((status) => [status.sessionId, status.status]));
    const ready = [...waiting].filter(([sessionId]) => !agentSessionBusy(statuses.get(sessionId)));
    if (ready.length === 0) return;
    setWaiting((current) => { const next = new Map(current); for (const [sessionId] of ready) next.delete(sessionId); return next; });
    for (const [sessionId, accountId] of ready) {
      if (sessions.some((session) => session.id === sessionId && session.lifecycle_state === "running")) restart(sessionId, accountId);
    }
  }, [agentStatuses, restart, sessions, waiting]);

  const apply = (pending: Pending) => {
    setWaiting((current) => {
      const next = new Map(current);
      for (const sessionId of pending.sessionIds) next.set(sessionId, pending.accountId);
      return next;
    });
  };

  const choose = (policy: Exclude<AgentAccountSwitchPolicy, "ask">) => {
    if (!prompt) return;
    if (remember) writeAgentAccountSwitchPolicy(policy);
    if (policy === "restart") apply(prompt);
    setPrompt(undefined);
    setRemember(false);
  };

  const switchTo = (agentId: ProviderId, accountId: string, accountName: string) => {
    if (!accounts || saving) return;
    setSaving(true);
    setFailure(undefined);
    actions.setDefault(profileId, { agentId, accountId, expectedRevision: accounts.revision })
      .then((next) => {
        setAccounts(next);
        const affected = sessionsOnOtherAccounts(sessions, agentId, accountId).map((session) => session.id);
        if (affected.length === 0) return;
        const pending = { agentId, accountId, accountName, sessionIds: affected };
        const policy = readAgentAccountSwitchPolicy();
        if (policy === "restart") apply(pending);
        else if (policy === "ask") setPrompt(pending);
      })
      .catch(() => setFailure("The daemon rejected that change. Reopen to try again."))
      .finally(() => setSaving(false));
  };

  const active = (agentId: ProviderId) => accounts?.accounts.find((account) => account.agentId === agentId && account.isDefault);
  const usageOf = (agentId: string, accountId: string) => usage.find((item) => item.agentId === agentId && item.accountId === accountId);
  const summary = PROVIDERS.map(({ id, label }) => {
    const account = active(id);
    return account ? { label, value: identityLabel(usageOf(id, account.accountId)?.identity) ?? account.name } : undefined;
  }).filter((row): row is { label: "Claude" | "Codex"; value: string } => row !== undefined);
  const waitingCount = waiting.size;

  return (
    <div ref={rootRef} className="agent-account-switcher sidebar-footer-control">
      <button
        type="button"
        className={`sidebar-footer-button agent-account-trigger${waitingCount ? " is-waiting" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={hoverCardId}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="agent" />
        <span className="visually-hidden">Agent accounts</span>
      </button>
      <SidebarFooterHoverCard
        id={hoverCardId}
        eyebrow="Agents"
        title="Accounts"
        status={disabled ? "Needs a connected computer with write access." : failure ?? (waitingCount ? `${waitingCount} Session(s) switch when their turn ends.` : "Which Claude and Codex accounts new Agents use.")}
        rows={summary}
        hint={disabled ? "Unavailable" : "Click to switch"}
      />
      {open ? <section className="agent-account-panel" role="dialog" aria-label="Agent accounts">
        {PROVIDERS.map(({ id, label }) => {
          const current = active(id);
          const others = accounts?.accounts.filter((account) => account.agentId === id && !account.isDefault) ?? [];
          const currentUsage = current ? usageOf(id, current.accountId) : undefined;
          return <div key={id} className="agent-account-section">
            <header><Icon name={id} /><h3>{label}</h3></header>
            <p className="agent-account-eyebrow">Active</p>
            {current ? <div className="agent-account-active">
              <strong>{current.name}</strong>
              {identityLabel(currentUsage?.identity) ? <small>{identityLabel(currentUsage?.identity)}</small> : null}
              {currentUsage ? <UsageWindows usage={currentUsage} compact /> : null}
            </div> : <p className="agent-account-empty">{accounts ? "No account" : "Reading accounts…"}</p>}
            {others.length ? <>
              <p className="agent-account-eyebrow">Switch to</p>
              <ul className="agent-account-options">
                {others.map((account) => {
                  const who = identityLabel(usageOf(id, account.accountId)?.identity);
                  return <li key={account.accountId}><button type="button" disabled={saving} onClick={() => switchTo(id, account.accountId, account.name)}>
                    <span>{account.name}</span>{who ? <small>{who}</small> : null}
                  </button></li>;
                })}
              </ul>
            </> : null}
          </div>;
        })}
        {prompt ? <div className="agent-account-prompt" role="alertdialog" aria-label="Running Sessions">
          <p>{prompt.sessionIds.length} running {PROVIDERS.find((provider) => provider.id === prompt.agentId)?.label} Session(s) still use another account. Restart them on {prompt.accountName}? Their conversations continue; busy Agents finish their turn first.</p>
          <label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Don't ask again</label>
          <div className="agent-account-prompt-actions">
            <button type="button" onClick={() => choose("keep")}>Keep running</button>
            <button type="button" className="primary" onClick={() => choose("restart")}>Restart Sessions</button>
          </div>
        </div> : null}
        {failure ? <p className="agent-account-failure">{failure}</p> : null}
        <footer><button type="button" onClick={() => { setOpen(false); openSettings(); }}>Manage Accounts…</button></footer>
      </section> : null}
    </div>
  );
}
