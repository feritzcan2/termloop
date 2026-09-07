import { Icon } from "./Icon.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAuthOperationDto, AgentAuthOperationParams, AgentAuthStatusDto, AgentAuthSubmitCodeParams, AgentConnectionProvider } from "@termloop/contract/current";
import type { ConnectionProfileSummary } from "../../connection-profile-types.js";

export type AgentConnectionActions = {
  list(profileId: string): Promise<AgentAuthStatusDto[]>;
  start(profileId: string, agentId: AgentConnectionProvider, action: "install" | "signIn" | "signOut"): Promise<AgentAuthOperationDto>;
  get(profileId: string, params: AgentAuthOperationParams): Promise<AgentAuthOperationDto>;
  cancel(profileId: string, params: AgentAuthOperationParams): Promise<AgentAuthOperationDto>;
  submitCode(profileId: string, params: AgentAuthSubmitCodeParams): Promise<AgentAuthOperationDto>;
  openSignIn(profileId: string, params: AgentAuthOperationParams): Promise<void>;
};

export function operationActive(operation: AgentAuthOperationDto | null | undefined): boolean {
  return Boolean(operation && ["starting", "installing", "awaitingBrowser", "awaitingCode"].includes(operation.phase));
}

export function AgentConnectionsPanel({ profile, actions }: { profile: ConnectionProfileSummary; actions: AgentConnectionActions }) {
  const [statuses, setStatuses] = useState<AgentAuthStatusDto[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const canManage = profile.scope !== "readOnly" && profile.enabled && profile.state !== "offline" && profile.state !== "connecting" && (profile.transport === "local" || profile.state === "connected");
  const refresh = useCallback(async () => {
    if (!canManage) return;
    const request = ++generation.current;
    setLoading(true); setError(undefined);
    try { const next = await actions.list(profile.id); if (mounted.current && generation.current === request) setStatuses(next); }
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
    <p className="agent-account-scope">Credentials stay in each provider’s own storage under the server user. Every TermLoop client using that server user shares these accounts.</p>
    {!canManage ? <p className="conn-banner warning">{profile.scope === "readOnly" ? "Full access is required to manage agent accounts." : "Connect to this server to manage its agent accounts."}</p> : <>
      {error ? <p role="alert" className="conn-banner error">{error}</p> : null}
      {!statuses && loading ? <div role="status" className="conn-skeleton">Checking installed agents…</div> : null}
      <div className="agent-account-list">{statuses?.map((status) => <AgentAccountCard key={status.agentId} status={status} profileId={profile.id} actions={actions} refresh={refresh} />)}</div>
      <p className="conn-note">Installation uses the official npm package for this server user, without sudo. Node.js and npm must already be installed. Account login does not share this computer’s apps, files or browser sessions.</p>
    </>}
  </section>;
}

function AgentAccountCard({ status, profileId, actions, refresh }: { status: AgentAuthStatusDto; profileId: string; actions: AgentConnectionActions; refresh(): Promise<void> }) {
  const [operation, setOperation] = useState(status.operation);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [code, setCode] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const mounted = useRef(true);
  const intent = useRef(0);
  const active = operationActive(operation);
  const busy = active || pending || (status.busy && !status.operation);
  useEffect(() => { setOperation(status.operation); }, [status.operation]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!operation || !operationActive(operation)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const requestIntent = intent.current;
      try {
        const next = await actions.get(profileId, { agentId: status.agentId, operationId: operation.operationId });
        if (cancelled) return;
        if (requestIntent !== intent.current) { timer = setTimeout(() => void poll(), 2000); return; }
        setOperation(next); setError(undefined);
        if (!operationActive(next)) { setCode(""); await refresh(); return; }
      } catch (cause) { if (!cancelled && requestIntent === intent.current) setError(message(cause)); }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 750);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [actions, profileId, status.agentId, operation?.operationId, active, refresh]);

  const perform = async (work: () => Promise<AgentAuthOperationDto | void>) => {
    intent.current += 1;
    setPending(true); setError(undefined);
    try { const next = await work(); if (mounted.current && next) setOperation(next); }
    catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { if (mounted.current) setPending(false); }
  };
  const start = (action: "install" | "signIn" | "signOut") => {
    setCode(""); setConfirmLogout(false);
    void perform(() => actions.start(profileId, status.agentId, action));
  };
  const params = { agentId: status.agentId, operationId: operation?.operationId ?? "" };
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
      {active ? <button type="button" disabled={pending} onClick={() => { setCode(""); void perform(() => actions.cancel(profileId, params)); }}>Cancel setup</button> : <>
        {!status.installed ? <button type="button" className="conn-primary" disabled={busy || !status.installSupported} onClick={() => start("install")}>Install {status.label}</button> : <>
          <button type="button" className="conn-primary" disabled={busy} onClick={() => start("signIn")}>{status.authState === "signedIn" ? "Reconnect account" : "Sign in"}</button>
          <button type="button" disabled={busy || !status.installSupported} onClick={() => start("install")}>Update CLI</button>
          {status.authState === "signedIn" ? <button type="button" className="conn-danger" disabled={busy} onClick={() => setConfirmLogout(true)}>Sign out</button> : null}
        </>}
      </>}
    </div>
    {!status.installed && !status.installSupported ? <p className="conn-note">Install Node.js and npm on the server, or install this CLI manually, then refresh. Automatic installation is supported on Linux and macOS.</p> : null}
    {confirmLogout ? <div className="conn-banner warning" role="alert"><p>Sign out of {status.label} for every client using this server account? Existing agents may need to sign in again.</p><button type="button" disabled={busy} onClick={() => start("signOut")}>Sign out on server</button> <button type="button" onClick={() => setConfirmLogout(false)}>Keep connected</button></div> : null}
  </article>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : "Account setup is unavailable. Reconnect to the server and try again."; }
