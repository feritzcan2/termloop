import type { AgentAccountDto, AgentAccountListResult, AgentAccountCreateParams, AgentAccountDeleteParams, AgentAccountIdentityDto, AgentAccountRenameParams, AgentAccountSetDefaultParams, AgentAccountUsageDto, AgentAccountUsageWindowDto, AgentAccountUsageListParams, AgentAccountUsageListResult, AgentAuthStatusListParams } from "@termloop/contract/current";
import { Icon } from "./Icon.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentAuthOperationDto, AgentAuthOperationParams, AgentAuthStatusDto, AgentAuthSubmitCodeParams, AgentConnectionProvider } from "@termloop/contract/current";
import type { ConnectionProfileSummary } from "../../connection-profile-types.js";

export type AgentConnectionActions = {
  accounts(profileId: string): Promise<AgentAccountListResult>;
  create(profileId: string, params: AgentAccountCreateParams): Promise<AgentAccountListResult>;
  rename(profileId: string, params: AgentAccountRenameParams): Promise<AgentAccountListResult>;
  setDefault(profileId: string, params: AgentAccountSetDefaultParams): Promise<AgentAccountListResult>;
  remove(profileId: string, params: AgentAccountDeleteParams): Promise<AgentAccountListResult>;
  usage(profileId: string, params?: AgentAccountUsageListParams): Promise<AgentAccountUsageListResult>;
  list(profileId: string, params?: AgentAuthStatusListParams): Promise<AgentAuthStatusDto[]>;
  start(profileId: string, agentId: AgentConnectionProvider, accountId: string, action: "install" | "signIn" | "signOut"): Promise<AgentAuthOperationDto>;
  get(profileId: string, params: AgentAuthOperationParams): Promise<AgentAuthOperationDto>;
  cancel(profileId: string, params: AgentAuthOperationParams): Promise<AgentAuthOperationDto>;
  submitCode(profileId: string, params: AgentAuthSubmitCodeParams): Promise<AgentAuthOperationDto>;
  openSignIn(profileId: string, params: AgentAuthOperationParams): Promise<void>;
};

export function operationActive(operation: AgentAuthOperationDto | null | undefined): boolean {
  return Boolean(operation && ["starting", "installing", "awaitingBrowser", "awaitingCode"].includes(operation.phase));
}

const PROVIDER_LABEL: Record<AgentConnectionProvider, string> = { claude: "Claude", codex: "Codex" };

/** Who an account is signed in as, e.g. `a@b.c (Acme, Max plan)`. */
export function identityLabel(identity: AgentAccountIdentityDto | null | undefined): string | undefined {
  const detail = [identity?.organizationName, identity?.plan ? `${identity.plan.charAt(0).toUpperCase()}${identity.plan.slice(1)} plan` : undefined]
    .filter((part): part is string => Boolean(part));
  const who = identity?.email ?? detail.shift();
  if (!who) return undefined;
  return detail.length ? `${who} (${detail.join(", ")})` : who;
}

/** Other accounts of the same provider signed in as the same user and organization. */
export function duplicateLogins(usage: AgentAccountUsageDto[], account: AgentAccountUsageDto): AgentAccountUsageDto[] {
  const email = account.identity?.email?.toLowerCase();
  if (!email) return [];
  return usage.filter((other) => other.agentId === account.agentId && other.accountId !== account.accountId
    && other.identity?.email?.toLowerCase() === email
    && (other.identity.organizationName ?? null) === (account.identity?.organizationName ?? null));
}

function meterTone(percent: number): string {
  return percent >= 90 ? " high" : percent >= 70 ? " elevated" : "";
}

/** One limit window: a thin bar with the used share and when it resets. */
export function UsageMeter({ window, label, column }: { window: AgentAccountUsageWindowDto | undefined; label: string; column?: string }) {
  if (!window) return <span className="agent-meter empty" aria-label={`${label}: no data`}>{column ? <span className="agent-meter-column">{column}</span> : null}–</span>;
  const used = Math.round(window.usedPercent);
  return <span className="agent-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used} aria-label={`${label} usage`}>
    <span className="agent-meter-track"><span className={`agent-meter-fill${meterTone(window.usedPercent)}`} style={{ width: `${Math.max(2, Math.min(100, window.usedPercent))}%` }} /></span>
    <span className="agent-meter-text">{column ? <span className="agent-meter-column">{column}</span> : null}<strong>{used}%</strong>{window.resetsAtEpochMs ? <small>resets {resetLabel(window.resetsAtEpochMs)}</small> : null}</span>
  </span>;
}

/** Every limit window of an account, labelled; used where columns are not shared. */
export function UsageWindows({ usage, compact = false }: { usage: AgentAccountUsageDto; compact?: boolean }) {
  if (usage.state !== "ok" || usage.windows.length === 0) return usage.message ? <p className="conn-note agent-usage-message">{usage.message}</p> : null;
  return <ul className={`agent-usage-windows${compact ? " compact" : ""}`} aria-label="Usage limits">
    {usage.windows.map((window) => <li key={`${window.kind}-${window.label}`}>
      <span className="agent-usage-label">{window.label}</span>
      <UsageMeter window={window} label={window.label} />
    </li>)}
  </ul>;
}

export function resetLabel(epochMs: number, now = Date.now()): string {
  const date = new Date(epochMs);
  const minutes = Math.round((epochMs - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  return date.toDateString() === new Date(now).toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function AgentConnectionsPanel({ profile, actions }: { profile: ConnectionProfileSummary; actions: AgentConnectionActions }) {
  const [accounts, setAccounts] = useState<AgentAccountListResult>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const canManage = profile.scope !== "readOnly" && profile.enabled && profile.state !== "offline" && profile.state !== "connecting" && (profile.transport === "local" || profile.state === "connected");
  const refresh = useCallback(async () => {
    if (!canManage) return;
    const request = ++generation.current;
    setLoading(true); setError(undefined);
    try { const next = await actions.accounts(profile.id); if (mounted.current && generation.current === request) { setAccounts(next); setRefreshKey((key) => key + 1); } }
    catch (cause) { if (mounted.current && generation.current === request) setError(message(cause)); }
    finally { if (mounted.current && generation.current === request) setLoading(false); }
  }, [actions, canManage, profile.id]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; generation.current += 1; };
  }, [refresh]);

  return <section className="agent-connections" aria-label={`Agent accounts on ${profile.name}`}>
    <div className="agent-connections-bar">
      <p>Accounts sign in on <strong>{profile.name}</strong>. New Agents use each provider's default; running Agents keep the account they started with.</p>
      <button type="button" className="agent-quiet-button" disabled={loading || !canManage} onClick={() => void refresh()}>{loading ? "Checking…" : "Refresh"}</button>
    </div>
    {!canManage ? <p className="conn-banner warning">{profile.scope === "readOnly" ? "Full access is required to manage agent accounts." : "Connect to this server to manage its agent accounts."}</p> : <>
      {error ? <p role="alert" className="conn-banner error">{error}</p> : null}
      {!accounts && loading ? <div role="status" className="conn-skeleton">Loading accounts…</div> : null}
      {accounts ? (["codex", "claude"] as const).map((agentId) => <ProviderAccounts key={agentId} agentId={agentId} snapshot={accounts} profileId={profile.id} actions={actions} refresh={refresh} refreshKey={refreshKey} update={setAccounts} />) : null}
      <p className="agent-connections-footnote">Installing uses the official npm package for this server user, without sudo, so Node.js and npm must already be there. Signing in never shares this computer's apps, files or browser sessions.</p>
    </>}
  </section>;
}

function windowOf(usage: AgentAccountUsageDto | undefined, kind: "session" | "weekly"): AgentAccountUsageWindowDto | undefined {
  return usage?.state === "ok" ? usage.windows.find((window) => window.kind === kind) : undefined;
}

function ProviderAccounts({ agentId, snapshot, profileId, actions, refresh, refreshKey, update }: {
  agentId: AgentConnectionProvider; snapshot: AgentAccountListResult; profileId: string; actions: AgentConnectionActions;
  refresh(): Promise<void>; refreshKey: number; update(value: AgentAccountListResult): void;
}) {
  const label = PROVIDER_LABEL[agentId];
  const accounts = snapshot.accounts.filter((account) => account.agentId === agentId);
  const [selectedId, select] = useState(() => accounts.find((account) => account.isDefault)?.accountId ?? "default");
  const selected = accounts.find((account) => account.accountId === selectedId) ?? accounts[0]!;
  const [editing, setEditing] = useState<"add" | "rename">();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [usage, setUsage] = useState<AgentAccountUsageDto[]>();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    actions.usage(profileId, { agentId, refresh: refreshKey > 1 }).then((result) => { if (current) setUsage(result.accounts); }, () => { if (current) setUsage([]); });
    return () => { current = false; };
  }, [actions, profileId, agentId, refreshKey]);
  const mutate = async (work: () => Promise<AgentAccountListResult>) => {
    setPending(true); setError(undefined);
    try {
      const result = await work();
      if (!alive.current) return;
      update(result); setEditing(undefined); setConfirmDelete(false); setName("");
      if (!result.accounts.some((account) => account.accountId === selected.accountId && account.agentId === agentId)) select(result.accounts.find((account) => account.agentId === agentId && account.isDefault)?.accountId ?? "default");
      if (result.createdAccountId) select(result.createdAccountId);
    } catch (cause) { if (alive.current) { setError(message(cause)); await refresh(); } }
    finally { if (alive.current) setPending(false); }
  };
  const paramsFor = (account: AgentAccountDto) => ({ agentId, accountId: account.accountId, expectedRevision: snapshot.revision });
  const open = (account: AgentAccountDto) => { select(account.accountId); setEditing(undefined); setConfirmDelete(false); setError(undefined); };
  const nameForm = (mode: "add" | "rename") => <form className="agent-account-name-form" onSubmit={(event) => { event.preventDefault(); void mutate(() => mode === "add" ? actions.create(profileId, { agentId, name: name.trim(), expectedRevision: snapshot.revision }) : actions.rename(profileId, { ...paramsFor(selected), name: name.trim() })); }}>
    <label className="conn-field"><span>{mode === "add" ? `Name the new ${label} account` : "Account name"}</span><input autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Work or Personal" /></label>
    <button className="conn-primary" type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : mode === "add" ? "Create account" : "Save name"}</button>
    <button type="button" className="agent-quiet-button" disabled={pending} onClick={() => setEditing(undefined)}>Cancel</button>
  </form>;

  return <section className={`agent-provider-accounts ${agentId}`} aria-label={`${label} accounts`}>
    <header className="agent-provider-head">
      <span className="agent-provider-mark" aria-hidden="true"><Icon name={agentId} /></span>
      <h4>{label}</h4>
      <button type="button" className="agent-quiet-button" disabled={pending || accounts.length >= 16} onClick={() => { setEditing("add"); setName(""); setConfirmDelete(false); }}>Add account</button>
    </header>
    <div className="agent-roster" role="list">
      <div className="agent-roster-columns" aria-hidden="true"><span /><span>Account</span><span>Session</span><span>Weekly</span><span /></div>
      {accounts.map((account) => {
        const own = usage?.find((item) => item.accountId === account.accountId);
        const shared = own ? duplicateLogins(usage ?? [], own).map((other) => accounts.find((candidate) => candidate.accountId === other.accountId)?.name ?? other.accountId) : [];
        const expanded = account.accountId === selected.accountId;
        const who = !usage ? "Checking…" : !own ? "Usage unavailable" : own.state === "ok" ? identityLabel(own.identity) ?? "Signed in" : own.state === "signedOut" ? "Not signed in" : own.message ?? "Usage unavailable";
        return <div key={account.accountId} role="listitem" className={`agent-roster-row${expanded ? " expanded" : ""}${account.isDefault ? " is-default" : ""}`}>
          <button type="button" className="agent-roster-summary" aria-expanded={expanded} aria-label={`${account.name}${account.isDefault ? ", default" : ""}`} onClick={() => open(account)}>
            <span className="agent-roster-dot" aria-hidden="true" />
            <span className="agent-roster-who">
              <strong>{account.name}</strong>
              <small className={own?.state === "ok" ? "" : "muted"}>{who}</small>
              {shared.length ? <small className="agent-roster-shared">Same login as {shared.join(", ")}, so limits are shared</small> : null}
            </span>
            <UsageMeter window={windowOf(own, "session")} label={`${account.name} session`} column="Session" />
            <UsageMeter window={windowOf(own, "weekly")} label={`${account.name} weekly`} column="Weekly" />
          </button>
          <span className="agent-roster-end">
            {account.isDefault ? <span className="agent-roster-default">Default</span>
              : <button type="button" className="agent-quiet-button" disabled={pending} onClick={() => void mutate(() => actions.setDefault(profileId, paramsFor(account)))}>Make default</button>}
          </span>
          {expanded ? <div className="agent-roster-detail">
            {own?.state === "ok" && own.windows.length > 2 ? <UsageWindows usage={{ ...own, windows: own.windows.filter((window) => window.kind !== "session" && window.kind !== "weekly") }} /> : null}
            {editing === "rename" ? nameForm("rename") : null}
            {confirmDelete ? <div className="conn-banner warning" role="alert">
              <p>Remove <strong>{account.name}</strong>? TermLoop signs it out on this server and deletes its private provider folder. Agents still using it must move to another account or be closed first.</p>
              <div className="agent-banner-actions"><button type="button" className="conn-danger" disabled={pending} onClick={() => void mutate(() => actions.remove(profileId, paramsFor(account)))}>{pending ? "Removing…" : "Remove account"}</button><button type="button" className="agent-quiet-button" disabled={pending} onClick={() => setConfirmDelete(false)}>Keep account</button></div>
            </div> : null}
            {error ? <p role="alert" className="conn-banner error">{error}</p> : null}
            <AccountStatus key={account.accountId} account={account} profileId={profileId} actions={actions} refreshKey={refreshKey}
              manage={<>
                <button type="button" className="agent-quiet-button" disabled={pending} onClick={() => { setEditing("rename"); setName(account.name); setConfirmDelete(false); }}>Rename</button>
                {account.accountId !== "default" ? <button type="button" className="agent-quiet-button danger" disabled={pending} onClick={() => { setConfirmDelete(true); setEditing(undefined); }}>Remove</button> : null}
              </>} />
          </div> : null}
        </div>;
      })}
      {editing === "add" ? <div role="listitem" className="agent-roster-row adding">{nameForm("add")}</div> : null}
    </div>
  </section>;
}

function AccountStatus({ account, profileId, actions, refreshKey, manage }: { account: AgentAccountDto; profileId: string; actions: AgentConnectionActions; refreshKey: number; manage: ReactNode }) {
  const [status, setStatus] = useState<AgentAuthStatusDto>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const [next] = await actions.list(profileId, { agentId: account.agentId, accountId: account.accountId });
      if (!next || next.agentId !== account.agentId || next.accountId !== account.accountId) throw new Error("The server returned a different account. Refresh to retry.");
      if (request === generation.current) { setStatus(next); setError(undefined); }
    } catch (cause) { if (request === generation.current) setError(message(cause)); }
  }, [actions, profileId, account.agentId, account.accountId]);
  useEffect(() => { void refresh(); return () => { generation.current += 1; }; }, [refresh, refreshKey]);
  return <>{error ? <div role="alert" className="conn-banner error"><p>{error}</p><button type="button" className="agent-quiet-button" onClick={() => { setError(undefined); void refresh(); }}>Retry account check</button></div> : null}{status ? <AccountSetup status={status} profileId={profileId} actions={actions} refresh={refresh} manage={manage} /> : !error ? <div role="status" className="conn-skeleton">Checking this account…</div> : null}</>;
}

function AccountSetup({ status, profileId, actions, refresh, manage }: { status: AgentAuthStatusDto; profileId: string; actions: AgentConnectionActions; refresh(): Promise<void>; manage: ReactNode }) {
  const [operation, setOperation] = useState(status.operation);
  const cancelledOperation = useRef<string | undefined>(undefined);
  const acceptOperation = useCallback((next: AgentAuthOperationDto | null) => {
    setOperation(next && next.operationId === cancelledOperation.current && operationActive(next)
      ? { ...next, verificationUrl: null, userCode: null, acceptsCode: false, message: "Cancelling…" } : next);
  }, []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [code, setCode] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const mounted = useRef(true);
  const intent = useRef(0);
  const active = operationActive(operation);
  const busy = active || pending || status.busy;
  useEffect(() => { acceptOperation(status.operation); }, [status.operation, acceptOperation]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!operation || !operationActive(operation)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const requestIntent = intent.current;
      try {
        const next = await actions.get(profileId, { agentId: status.agentId, accountId: status.accountId, operationId: operation.operationId });
        if (cancelled) return;
        if (requestIntent !== intent.current) { timer = setTimeout(() => void poll(), 2000); return; }
        acceptOperation(next); setError(undefined);
        if (!operationActive(next)) { setCode(""); await refresh(); return; }
      } catch (cause) { if (!cancelled && requestIntent === intent.current) setError(message(cause)); }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 750);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [actions, profileId, status.agentId, status.accountId, operation?.operationId, active, refresh, acceptOperation]);

  const perform = async (work: () => Promise<AgentAuthOperationDto | void>) => {
    intent.current += 1;
    setPending(true); setError(undefined);
    try { const next = await work(); if (mounted.current && next) acceptOperation(next); }
    catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { if (mounted.current) setPending(false); }
  };
  const start = (action: "install" | "signIn" | "signOut") => {
    cancelledOperation.current = undefined;
    setCode(""); setConfirmLogout(false);
    void perform(() => actions.start(profileId, status.agentId, status.accountId, action));
  };
  const params = { agentId: status.agentId, accountId: status.accountId, operationId: operation?.operationId ?? "" };
  const ready = status.installed && status.authState === "signedIn";
  return <div className="agent-account-setup">
    {!ready ? <ol className="agent-account-steps" aria-label="Setup progress">
      <li className={status.installed ? "done" : "current"}>Install {status.label}</li>
      <li className={status.authState === "signedIn" ? "done" : status.installed ? "current" : ""}>Sign in</li>
      <li>Ready for Agents</li>
    </ol> : null}
    {status.busy && !operation ? <p className="conn-note">Another connection is setting up this account. Refresh when it finishes.</p> : null}
    {operation ? <div className="agent-auth-progress" role="status" aria-live="polite">
      <p>{operation.message}</p>
      {active && operation.verificationUrl ? <>
        {operation.userCode ? <div className="agent-device-code"><span>One-time code</span><code>{operation.userCode}</code></div> : null}
        <button type="button" className="conn-primary" disabled={pending} onClick={() => void perform(() => actions.openSignIn(profileId, params))}>Open sign-in page</button>
        <small>Use your browser on this computer. This attempt expires after 15 minutes.</small>
      </> : null}
      {active && operation.acceptsCode ? <form onSubmit={(event) => { event.preventDefault(); const submitted = code.trim(); setCode(""); void perform(() => actions.submitCode(profileId, { ...params, code: submitted })); }}>
        <label className="conn-field"><span>Authorization code from browser</span><input autoComplete="off" spellCheck={false} type="password" maxLength={2048} value={code} onChange={(event) => setCode(event.target.value)} /></label>
        <button type="submit" className="conn-primary" disabled={pending || !code.trim()}>Complete sign-in</button>
      </form> : null}
    </div> : null}
    {error ? <p role="alert" className="conn-banner error">{error}</p> : null}
    {confirmLogout ? <div className="conn-banner warning" role="alert"><p>Sign out of this {status.label} account on the server? Agents using this account may need to sign in again. Other accounts stay connected.</p><div className="agent-banner-actions"><button type="button" className="conn-danger" disabled={busy} onClick={() => start("signOut")}>Sign out on server</button><button type="button" className="agent-quiet-button" onClick={() => setConfirmLogout(false)}>Keep connected</button></div></div> : null}
    <div className="agent-account-actions">
      {active ? <button type="button" className="agent-quiet-button" disabled={pending} onClick={() => { cancelledOperation.current = operation!.operationId; setCode(""); acceptOperation(operation); void perform(() => actions.cancel(profileId, params)); }}>Cancel setup</button> : <>
        {!status.installed ? <button type="button" className="conn-primary" disabled={busy || !status.installSupported} onClick={() => start("install")}>Install {status.label}</button>
          : <button type="button" className={ready ? "agent-quiet-button" : "conn-primary"} disabled={busy} onClick={() => start("signIn")}>{ready ? "Reconnect account" : "Sign in"}</button>}
        {status.installed ? <button type="button" className="agent-quiet-button" disabled={busy || !status.installSupported} onClick={() => start("install")}>Update CLI</button> : null}
      </>}
      {manage}
      {status.authState === "signedIn" && !active ? <button type="button" className="agent-quiet-button danger" disabled={busy} onClick={() => setConfirmLogout(true)}>Sign out</button> : null}
      {status.version ? <span className="agent-account-version">{status.version}</span> : null}
    </div>
    {!status.installed && !status.installSupported ? <p className="conn-note">Install Node.js and npm on the server, or install this CLI manually, then refresh. Automatic installation is supported on Linux and macOS.</p> : null}
  </div>;
}

function message(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message.includes("request timeout")
      ? "This server took too long to respond. Retry, or check its connection."
      : cause.message;
  }
  return "Account setup is unavailable. Reconnect to the server and try again.";
}
