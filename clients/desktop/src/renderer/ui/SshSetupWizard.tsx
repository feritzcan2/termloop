import { useEffect, useRef, useState, type FormEvent } from "react";
import "./ssh-setup.css";
import type { ConnectionProfileConnectResult } from "../../connection-profile-types.js";
import type { SshSetupActions, SshSetupState } from "../../ssh-setup-types.js";
import { parseSshSetupAddress } from "../../ssh-setup-types.js";

export function SshSetupWizard({ actions, connected, useExisting }: {
  actions: SshSetupActions;
  useExisting?: () => void;
  connected(result: ConnectionProfileConnectResult): Promise<void>;
}) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const [user, setUser] = useState("");
  const enteredUser = useRef(false);
  const [port, setPort] = useState("");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [operation, setOperation] = useState<SshSetupState>();
  const [localBusy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const busy = localBusy || restoring || !!operation?.busy;
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const activeId = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const pending = useRef(false);
  const connectionAttempt = useRef<string | undefined>(undefined);
  const currentActions = useRef(actions);
  currentActions.current = actions;

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    void currentActions.current.current().then((state) => {
      if (stopped || !state) return;
      activeId.current = state.id;
      setOperation(state);
    }).catch((error: unknown) => { if (!stopped) setError(setupErrorMessage(error)); })
      .finally(() => { if (!stopped) setRestoring(false); });
    return () => { stopped = true; mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!operation || !(operation.busy || operation.phase === "checking" || operation.phase === "installing")) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await currentActions.current.status(operation.id);
        if (!stopped) setOperation(next);
      } catch (error) {
        if (!stopped) setOperation({ ...operation, phase: "error", busy: false, message: setupErrorMessage(error) });
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 1000);
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [operation?.id, operation?.phase, operation?.busy]);

  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (error) { if (mounted.current) setError(setupErrorMessage(error)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const next = await actions.start({ address, ...(name ? { name } : {}), ...(user ? { user } : {}), ...(port ? { sshPort: Number(port) } : {}) });
      if (!mounted.current) return;
      activeId.current = next.id;
      setTrusted(false);
      setOperation(next);
    });
  };

  const login = (event: FormEvent) => {
    event.preventDefault();
    if (!operation || !trusted) return;
    const credentials = { id: operation.id, fingerprint: operation.fingerprint, ...(password ? { password } : {}), ...(passphrase ? { passphrase } : {}) };
    setPassword("");
    setPassphrase("");
    void run(async () => {
      const next = await actions.login(credentials);
      if (mounted.current) setOperation(next);
    });
  };

  const reset = () => void run(async () => {
    if (activeId.current) await actions.cancel(activeId.current);
    activeId.current = undefined;
    connectionAttempt.current = undefined;
    if (mounted.current) { setOperation(undefined); setTrusted(false); setPassword(""); setPassphrase(""); setFinished(false); }
  });

  const phase = operation?.phase;
  const finishConnection = () => void run(async () => {
    if (!operation) return;
    const result = await actions.connect(operation.id);
    if (!mounted.current) return;
    await connected(result);
    if (mounted.current) setFinished(true);
  });
  useEffect(() => {
    if (operation?.phase !== "ready" || operation.busy || connectionAttempt.current === operation.id) return;
    connectionAttempt.current = operation.id;
    finishConnection();
  }, [operation?.id, operation?.phase, operation?.busy]);
  const currentStep = !operation || phase === "checking" ? 0 : phase === "identity" || phase === "login" ? 1 : phase === "ready" ? 3 : 2;
  return <section className="ssh-setup" aria-label="SSH server setup">
    <div className="ssh-setup-heading"><h3>Add a Linux server</h3><p>Connect with SSH. TermLoop will check the server and guide you through anything it needs.</p></div>
    <ol className="ssh-setup-steps" aria-label="Setup progress">
      {["Address", "Sign in", "Set up", "Ready"].map((label, index) => <li key={label} aria-current={index === currentStep ? "step" : undefined} className={index < currentStep ? "complete" : ""}><span>{index < currentStep ? "✓" : index + 1}</span>{label}</li>)}
    </ol>
    {!operation ? <form onSubmit={start}>
      <div className="conn-form-row ssh-setup-address">
        <label className="conn-field"><span>Server address</span><input autoFocus required value={address} onChange={(event) => {
          const next = event.target.value;
          setAddress(next);
          try { const parsed = parseSshSetupAddress({ address: next }); if (!enteredUser.current) setUser(parsed.user ?? ""); } catch { /* Validate the completed address on submit. */ }
        }} placeholder="ssh root@203.0.113.10" autoComplete="off" spellCheck={false} /></label>
        <label className="conn-field"><span>SSH user</span><input value={user} onChange={(event) => { enteredUser.current = !!event.target.value; setUser(event.target.value); }} placeholder="From SSH config" autoComplete="off" /></label>
      </div>
      <p className="conn-note">Paste an IP address, hostname or SSH command. New VPS providers usually give you the root user.</p>
      <details className="ssh-setup-advanced"><summary>Advanced options</summary><div className="conn-form-row">
        <label className="conn-field"><span>Display name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Automatic" maxLength={80} /></label>
        <label className="conn-field port"><span>SSH port</span><input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} placeholder="22 or SSH config" /></label>
      </div></details>
      <div className="conn-actions"><button className="conn-primary" disabled={busy} type="submit">{busy ? "Checking server…" : "Continue"}</button></div>
    </form> : <>
      <div className="ssh-setup-target"><strong>{operation.name}</strong><span>{operation.user}@{operation.host} · SSH {operation.sshPort}</span></div>
      <p className={phase === "error" ? "ssh-setup-status conn-banner error" : "ssh-setup-status"} role={phase === "error" ? "alert" : "status"} aria-live="polite">{busy && (phase === "identity" || phase === "login") ? "Signing in and checking the server…" : operation.message}</p>
      {(phase === "identity" || phase === "login") && <form onSubmit={login}>
        <div className="ssh-setup-identity"><span>SSH server fingerprint</span><code>{operation.fingerprint}</code>
          <label className="ssh-setup-trust"><input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />This matches the fingerprint from my server provider.</label>
        </div>
        <label className="conn-field"><span>Server password <small>if needed</small></span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" placeholder="Leave empty to use your SSH key" /></label>
        <p className="conn-note">Used for this setup attempt only. Future connections use an SSH key.</p>
        <details className="ssh-setup-advanced"><summary>My SSH key has a passphrase</summary><label className="conn-field"><span>Key passphrase</span><input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" /></label></details>
        <div className="conn-actions"><button type="button" onClick={reset} disabled={busy}>Back</button><button type="submit" className="conn-primary" disabled={busy || !trusted}>{busy ? "Signing in…" : "Verify and sign in"}</button></div>
      </form>}
      {(phase === "review" || phase === "installing") && <>
        <ul className="ssh-setup-plan">{operation.steps.map((step) => <li key={step}>{step}</li>)}</ul>
        <p className="conn-note">TermLoop runs under its server user. Agent credentials and projects stay on that server.</p>
        {phase === "review" && <div className="conn-actions"><button type="button" onClick={reset} disabled={busy}>Back</button><button type="button" className="conn-primary" disabled={busy} onClick={() => void run(async () => { const next = await actions.install(operation.id); if (mounted.current) setOperation(next); })}>{operation.installed ? "Prepare and connect" : "Install and connect"}</button></div>}
      </>}
      {(phase === "review" || phase === "error") && <details className="ssh-setup-advanced"><summary>Advanced options</summary><p>Using a development desktop build? Choose a Linux server package built from the same source.</p><button type="button" disabled={busy} onClick={() => void run(async () => { const next = await actions.choosePackage(operation.id); if (mounted.current) setOperation(next); })}>Choose server package…</button></details>}
      {phase === "error" && <div className="conn-actions"><button type="button" disabled={busy} onClick={reset}>Change connection</button><button type="button" className="conn-primary" disabled={busy} onClick={() => { setError(""); setOperation({ ...operation, phase: "login" }); }}>Sign in again</button></div>}
      {phase === "installing" && <div className="ssh-setup-working"><span className="ssh-setup-spinner" aria-hidden="true" />Setup may take a few minutes. You can close Settings and return here while TermLoop stays open.</div>}
      {phase === "ready" && <div className="conn-actions"><button type="button" className="conn-primary" disabled={busy || finished} onClick={finishConnection}>{finished ? "Connected" : busy ? "Connecting…" : "Retry connection"}</button></div>}
    </>}
    {error && <div className="conn-banner error" role="alert">{error}</div>}
    {(error || phase === "error" || (phase === "login" && !busy)) && <aside className="ssh-setup-help" aria-label="Setup help">
      <h4>Continue from your terminal</h4>
      <p>Use your usual SSH login to check the server, then return here and try again.</p>
      {operation?.host && <code>ssh -p {operation.sshPort} {operation.user}@{operation.host}</code>}
      <ul>
        <li>For download or package errors, check free disk space and the server’s internet connection.</li>
        <li>For a version mismatch, choose a Linux server package from the same build in Advanced options, or use a matching stable desktop and server release.</li>
        <li>Automatic setup supports Debian/Ubuntu x64 with systemd and SSH key or standard password access. Servers that require interactive MFA need a separately configured connection.</li>
      </ul>
      <p>For a Mac or Windows computer, install TermLoop there, open Settings → Servers → Share this computer, and enable SSH sharing. Enable Remote Login/OpenSSH on that computer and authorize this computer’s SSH key before connecting.</p>
      {useExisting && <button type="button" onClick={useExisting}>Connect to an already installed server</button>}
    </aside>}
  </section>;
}

export function setupErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "Server setup failed. Try again.";
  return text.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}
