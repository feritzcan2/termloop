import type { AgentAccountDto, AgentAccountListResult, AgentAccountCreateParams, AgentAccountRenameParams, AgentAccountSetDefaultParams, AgentAuthStatusListParams } from "@termloop/contract/current";
import { Icon } from "./Icon.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAuthOperationDto, AgentAuthOperationParams, AgentAuthStatusDto, AgentAuthSubmitCodeParams, AgentConnectionProvider } from "@termloop/contract/current";
import type { ConnectionProfileSummary } from "../../connection-profile-types.js";

export type AgentConnectionActions = {
  accounts(profileId: string): Promise<AgentAccountListResult>;
  create(profileId: string, params: AgentAccountCreateParams): Promise<AgentAccountListResult>;
  rename(profileId: string, params: AgentAccountRenameParams): Promise<AgentAccountListResult>;
  setDefault(profileId: string, params: AgentAccountSetDefaultParams): Promise<AgentAccountListResult>;
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
    <div className="conn-section-head">
      <div><h3>Agent accounts</h3><p className="conn-note">Install and sign in on <strong>{profile.name}</strong>. Your browser opens on this computer.</p></div>
      <button type="button" className="conn-scan" disabled={loading || !canManage} onClick={() => void refresh()}>{loading ? "Checking…" : "Refresh"}</button>
    </div>
    <p className="agent-account-scope">Add separate work or personal accounts for each provider. New sessions use the server default unless you select another account. Running sessions keep their original account.</p>
    {!canManage ? <p className="conn-banner warning">{profile.scope === "readOnly" ? "Full access is required to manage agent accounts." : "Connect to this server to manage its agent accounts."}</p> : <>
      {error ? <p role="alert" className="conn-banner error">{error}</p> : null}
      {!accounts && loading ? <div role="status" className="conn-skeleton">Loading accounts…</div> : null}
      <div className="agent-account-list">{accounts ? (["codex", "claude"] as const).map((agentId) => <ProviderAccounts key={agentId} agentId={agentId} snapshot={accounts} profileId={profile.id} actions={actions} refresh={refresh} refreshKey={refreshKey} update={setAccounts} />) : null}</div>
      <p className="conn-note">Installation uses the official npm package for this server user, without sudo. Node.js and npm must already be installed. Account login does not share this computer’s apps, files or browser sessions.</p>
    </>}
  </section>;
}

function ProviderAccounts({ agentId, snapshot, profileId, actions, refresh, refreshKey, update }: {
  agentId: AgentConnectionProvider; snapshot: AgentAccountListResult; profileId: string; actions: AgentConnectionActions;
  refresh(): Promise<void>; refreshKey: number; update(value: AgentAccountListResult): void;
}) {
  const accounts = snapshot.accounts.filter((account) => account.agentId === agentId);
  const [selectedId, select] = useState(() => accounts.find((account) => account.isDefault)?.accountId ?? "default");
  const selected = accounts.find((account) => account.accountId === selectedId) ?? accounts[0]!;
  const [editing, setEditing] = useState<"add" | "rename">();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const mutate = async (work: () => Promise<AgentAccountListResult>) => {
    setPending(true); setError(undefined);
    try {
      const result = await work();
      if (!alive.current) return;
      update(result); setEditing(undefined); setName("");
      if (result.createdAccountId) select(result.createdAccountId);
    } catch (cause) { if (alive.current) { setError(message(cause)); await refresh(); } }
    finally { if (alive.current) setPending(false); }
  };
  const params = { agentId, accountId: selected.accountId, expectedRevision: snapshot.revision };
  return <section className="agent-provider-accounts" aria-label={`${agentId === "codex" ? "Codex" : "Claude"} accounts`}>
    <div className="agent-account-selector">
      <label className="conn-field"><span>{agentId === "codex" ? "Codex" : "Claude"} account</span>
        <select aria-label={`${agentId} account`} value={selected.accountId} disabled={pending} onChange={(event) => { select(event.target.value); setEditing(undefined); setError(undefined); }}>
          {accounts.map((account) => <option key={account.accountId} value={account.accountId}>{account.name}{account.isDefault ? " · Default" : ""}</option>)}
        </select>
      </label>
      <button type="button" disabled={pending || accounts.length >= 16} onClick={() => { setEditing("add"); setName(""); }}>Add account</button>
      <button type="button" disabled={pending} onClick={() => { setEditing("rename"); setName(selected.name); }}>Rename</button>
      {!selected.isDefault ? <button type="button" disabled={pending} onClick={() => void mutate(() => actions.setDefault(profileId, params))}>Use by default</button> : <span className="conn-note">Default for new sessions</span>}
    </div>
    {editing ? <form className="agent-account-name-form" onSubmit={(event) => { event.preventDefault(); void mutate(() => editing === "add" ? actions.create(profileId, { agentId, name: name.trim(), expectedRevision: snapshot.revision }) : actions.rename(profileId, { ...params, name: name.trim() })); }}>
      <label className="conn-field"><span>{editing === "add" ? "New account name" : "Account name"}</span><input autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Work or Personal" /></label>
      <button className="conn-primary" type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : editing === "add" ? "Create account" : "Save name"}</button>
      <button type="button" disabled={pending} onClick={() => setEditing(undefined)}>Cancel</button>
    </form> : null}
    {error ? <p role="alert" className="conn-banner error">{error}</p> : null}
    <p className="conn-note">Credentials for this account stay on the server. All connected TermLoop clients can use it.</p>
    <AccountStatus key={selected.accountId} account={selected} profileId={profileId} actions={actions} refreshKey={refreshKey} />
  </section>;
}

function AccountStatus({ account, profileId, actions, refreshKey }: { account: AgentAccountDto; profileId: string; actions: AgentConnectionActions; refreshKey: number }) {
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
  return <>{error ? <div role="alert" className="conn-banner error"><p>{error}</p><button type="button" onClick={() => { setError(undefined); void refresh(); }}>Retry account check</button></div> : null}{status ? <AgentAccountCard status={status} profileId={profileId} actions={actions} refresh={refresh} /> : !error ? <div role="status" className="conn-skeleton">Checking this account…</div> : null}</>;
}

function AgentAccountCard({ status, profileId, actions, refresh }: { status: AgentAuthStatusDto; profileId: string; actions: AgentConnectionActions; refresh(): Promise<void> }) {
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
  const label = !status.installed ? "Not installed" : status.authState === "signedIn" ? "Connected" : status.authState === "signedOut" ? "Sign-in required" : "Status unknown";
  return <article className="agent-account-card">
    <header>
      <span className={`agent-account-icon ${status.agentId}`} aria-hidden="true"><Icon name={status.agentId} /></span>
      <div><h4>{status.label}</h4><span className="conn-note">{status.version ?? "Provider CLI"}</span></div>
      <span className={`agent-account-badge ${status.authState === "signedIn" ? "connected" : ""}`}>{busy ? (operation?.phase === "installing" ? "Installing…" : "Setup in progress") : label}</span>
    </header>
    <ol className="agent-account-steps" aria-label="Setup progress">
      <li className={status.installed ? "done" : ""}>1. Install</li>
      <li className={status.authState === "signedIn" ? "done" : ""}>2. Sign in</li>
      <li className={status.authState === "signedIn" ? "done" : ""}>3. Ready</li>
    </ol>
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
        <button type="submit" disabled={pending || !code.trim()}>Complete sign-in</button>
      </form> : null}
    </div> : null}
    {error ? <p role="alert" className="conn-banner error">{error}</p> : null}
    <div className="agent-account-actions">
      {active ? <button type="button" disabled={pending} onClick={() => { cancelledOperation.current = operation!.operationId; setCode(""); acceptOperation(operation); void perform(() => actions.cancel(profileId, params)); }}>Cancel setup</button> : <>
        {!status.installed ? <button type="button" className="conn-primary" disabled={busy || !status.installSupported} onClick={() => start("install")}>Install {status.label}</button> : <>
          <button type="button" className="conn-primary" disabled={busy} onClick={() => start("signIn")}>{status.authState === "signedIn" ? "Reconnect account" : "Sign in"}</button>
          <button type="button" disabled={busy || !status.installSupported} onClick={() => start("install")}>Update CLI</button>
          {status.authState === "signedIn" ? <button type="button" className="conn-danger" disabled={busy} onClick={() => setConfirmLogout(true)}>Sign out</button> : null}
        </>}
      </>}
    </div>
    {!status.installed && !status.installSupported ? <p className="conn-note">Install Node.js and npm on the server, or install this CLI manually, then refresh. Automatic installation is supported on Linux and macOS.</p> : null}
    {confirmLogout ? <div className="conn-banner warning" role="alert"><p>Sign out of this {status.label} account on the server? Sessions using this account may need to sign in again. Other accounts stay connected.</p><button type="button" disabled={busy} onClick={() => start("signOut")}>Sign out on server</button> <button type="button" onClick={() => setConfirmLogout(false)}>Keep connected</button></div> : null}
  </article>;
}

function message(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message.includes("request timeout")
      ? "This server took too long to respond. Retry, or check its connection."
      : cause.message;
  }
  return "Account setup is unavailable. Reconnect to the server and try again.";
}
