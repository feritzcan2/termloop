import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type {
  ConnectionProfileConnectInput,
  ConnectionProfileConnectResult,
  ConnectionProfileSummary,
  ConnectionSourceSummary,
  DiscoveredTailscaleServer,
  RemoteHostStatus,
  RemoteHostTransport,
  TailscaleServerDiscovery,
} from "../../connection-profile-types.js";

type MessagePlacement = "profiles" | "discovered" | "manual";
type Message = {
  kind: "error" | "warning" | "success";
  text: string;
  placement?: MessagePlacement;
};
type View = "connect" | "share";
type Tone = "ok" | "warn" | "danger" | "idle";

const DISCOVERY_REFRESH_MS = 10_000;

export function ConnectionProfilesDialog({
  close,
  connect,
  disableHost,
  discoverTailscaleServers,
  enableHost,
  hostStatus,
  list,
  remove,
  setEnabled,
  subscribeStatus,
}: {
  close(): void;
  connect(input: ConnectionProfileConnectInput): Promise<ConnectionProfileConnectResult>;
  disableHost(): Promise<RemoteHostStatus>;
  discoverTailscaleServers(): Promise<TailscaleServerDiscovery>;
  enableHost(transport: RemoteHostTransport): Promise<RemoteHostStatus>;
  hostStatus(): Promise<RemoteHostStatus>;
  list(): Promise<ConnectionProfileSummary[]>;
  remove(profileId: string): Promise<ConnectionProfileSummary[]>;
  setEnabled(profileId: string, enabled: boolean): Promise<ConnectionProfileSummary[]>;
  subscribeStatus(listener: (summary: ConnectionSourceSummary) => void): () => void;
}) {
  const [view, setView] = useState<View>("connect");
  const [profiles, setProfiles] = useState<ConnectionProfileSummary[]>();
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);

  // Discovery-first "add a computer" flow.
  const [discovery, setDiscovery] = useState<TailscaleServerDiscovery>();
  const [discovering, setDiscovering] = useState(true);
  const [connectingServer, setConnectingServer] = useState<string>();

  // Advanced / manual fallback (Tailscale address or SSH).
  const [manualTransport, setManualTransport] = useState<"tailscale" | "ssh">("tailscale");
  const [manualName, setManualName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [sshPort, setSshPort] = useState("43717");

  // Share this computer.
  const [shareTransport, setShareTransport] = useState<"tailscale" | "ssh">("tailscale");
  const [shareStatus, setShareStatus] = useState<RemoteHostStatus>();
  const [shareBusy, setShareBusy] = useState(false);
  const [shareMessage, setShareMessage] = useState<Message>();

  const latestStatuses = useRef(new Map<string, ConnectionSourceSummary>());
  const mounted = useRef(true);

  const refreshDiscovery = useCallback(async () => {
    setDiscovering(true);
    try {
      const next = await discoverTailscaleServers();
      if (mounted.current) setDiscovery(next);
    } catch (error) {
      if (!mounted.current) return;
      const text = errorMessage(error);
      // A transient rescan failure must not erase servers we already found.
      setDiscovery((prev) => prev && prev.servers.length
        ? { state: "ready", servers: prev.servers, message: `These results may be out of date — ${text}` }
        : { state: "unavailable", servers: [], message: text });
    } finally {
      if (mounted.current) setDiscovering(false);
    }
  }, [discoverTailscaleServers]);

  useEffect(() => {
    mounted.current = true;
    void refreshDiscovery();
    const timer = setInterval(() => void refreshDiscovery(), DISCOVERY_REFRESH_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refreshDiscovery]);

  useEffect(() => {
    let active = true;
    void list().then(
      (value) => { if (active) setProfiles(mergeConnectionProfileStatuses(value, latestStatuses.current)); },
      (error) => { if (active) setMessage({ kind: "error", text: errorMessage(error) }); },
    );
    return () => { active = false; };
  }, [list]);

  useEffect(() => subscribeStatus((summary) => {
    latestStatuses.current.set(summary.id, summary);
    setProfiles((current) => current && mergeConnectionProfileStatuses(current, latestStatuses.current));
  }), [subscribeStatus]);

  useEffect(() => {
    let active = true;
    void hostStatus().then(
      (value) => {
        if (!active) return;
        setShareStatus(value);
        if (value.warning) setShareMessage({ kind: "warning", text: value.warning });
      },
      (error) => { if (active) setShareMessage({ kind: "error", text: errorMessage(error) }); },
    );
    return () => { active = false; };
  }, [hostStatus]);

  const runConnect = async (
    input: ConnectionProfileConnectInput,
    onSuccess: () => void,
    failurePlacement: "discovered" | "manual",
  ) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await connect(input);
      setProfiles(mergeConnectionProfileStatuses(await list(), latestStatuses.current));
      onSuccess();
      setMessage(result.warning
        ? { kind: "warning", text: result.warning, placement: "profiles" }
        : { kind: "success", text: `Connected to ${result.profile.name}.`, placement: "profiles" });
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error), placement: failurePlacement });
    } finally {
      setBusy(false);
    }
  };

  const clearPlacedMessage = (placement: MessagePlacement) => {
    setMessage((current) => current?.placement === placement ? undefined : current);
  };

  const connectDiscovered = async (server: DiscoveredTailscaleServer) => {
    setConnectingServer(server.dnsName);
    await runConnect(
      {
        name: server.name,
        expectedServerFingerprint: server.serverFingerprint,
        transport: { kind: "tailscale", baseUrl: server.baseUrl },
      },
      () => undefined,
      "discovered",
    );
    setConnectingServer(undefined);
  };

  const submitManual = async (event: FormEvent) => {
    event.preventDefault();
    await runConnect(
      {
        name: manualName,
        transport: manualTransport === "tailscale"
          ? { kind: "tailscale", baseUrl: baseUrl.trim() }
          : {
              kind: "ssh",
              host: sshHost.trim(),
              ...(sshUser.trim() ? { user: sshUser.trim() } : {}),
              remotePort: Number(sshPort),
            },
      },
      () => {
        setManualName(""); setBaseUrl("");
        setSshHost(""); setSshUser("");
      },
      "manual",
    );
  };

  const changeEnabled = async (profileId: string, enabled: boolean) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setProfiles(mergeConnectionProfileStatuses(await setEnabled(profileId, enabled), latestStatuses.current));
      setMessage({ kind: "success", text: enabled ? "Server enabled." : "Server disabled.", placement: "profiles" });
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const removeProfile = async (profileId: string) => {
    setBusy(true);
    setMessage(undefined);
    try {
      setProfiles(mergeConnectionProfileStatuses(await remove(profileId), latestStatuses.current));
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const enableSharing = async () => {
    setShareBusy(true);
    setShareMessage(undefined);
    try {
      const next = await enableHost(shareTransport);
      setShareStatus(next);
      setShareMessage(next.warning
        ? { kind: "warning", text: next.warning }
        : {
            kind: "success",
            text: shareTransport === "tailscale"
              ? "This computer is now visible to TermLoop on your Tailscale network."
              : "Remote access is now available through SSH.",
          });
    } catch (error) {
      setShareMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setShareBusy(false);
    }
  };

  const disableSharing = async () => {
    setShareBusy(true);
    setShareMessage(undefined);
    try {
      const next = await disableHost();
      setShareStatus(next);
      setShareMessage(next.warning
        ? { kind: "warning", text: next.warning }
        : { kind: "success", text: "Remote access is off on this computer." });
    } catch (error) {
      setShareMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setShareBusy(false);
    }
  };

  function renderComputerCard(profile: ConnectionProfileSummary) {
    const isLocal = profile.transport === "local";
    const status = profileStatus(profile);
    return (
      <article className={isLocal ? "conn-card local" : "conn-card"} key={profile.id}>
        <div className="conn-card-main">
          <div className="conn-card-title">
            <strong>{profile.name}</strong>
            <span className="conn-chip">{transportLabel(profile.transport)}</span>
            {profile.scope === "readOnly" ? <span className="conn-chip readonly">Read only</span> : null}
          </div>
          {!isLocal ? <span className="conn-endpoint">{profile.endpoint}</span> : null}
          <div className="conn-status">
            <StatusDot tone={status.tone} />
            <span>{status.label}</span>
          </div>
          {profile.warning ? <small className="conn-warn-text">{profile.warning}</small> : null}
        </div>
        <div className="conn-card-actions">
          {isLocal ? <span className="conn-always">Always on</span> : (
            <>
              <button
                type="button"
                role="switch"
                aria-checked={profile.enabled}
                aria-label={profile.enabled ? `Disable ${profile.name}` : `Enable ${profile.name}`}
                className={profile.enabled ? "conn-switch on" : "conn-switch"}
                disabled={busy}
                onClick={() => void changeEnabled(profile.id, !profile.enabled)}
              >
                <span />
              </button>
              <button type="button" className="conn-remove" disabled={busy} onClick={() => void removeProfile(profile.id)}>Remove</button>
            </>
          )}
        </div>
      </article>
    );
  }

  function renderDiscoveredCard(server: DiscoveredTailscaleServer) {
    const added = profiles?.some((profile) => profile.transport === "tailscale" && profile.endpoint === server.baseUrl) ?? false;
    const connecting = connectingServer === server.dnsName;
    return (
      <article className="conn-card discovered" key={server.dnsName}>
        <div className="conn-card-main">
          <div className="conn-card-title">
            <strong>{server.name}</strong>
            <VerifiedBadge />
          </div>
          <span className="conn-endpoint">{server.dnsName}</span>
          <div className="conn-status"><StatusDot tone="ok" /><span>Sharing on · ready to connect</span></div>
          <details className="conn-fingerprint"><summary>Server identity</summary><code>{server.serverFingerprint}</code></details>
        </div>
        <div className="conn-card-actions">
          {added ? <span className="conn-always">Already added</span> : (
            <button
              type="button"
              className="conn-primary small"
              disabled={busy}
              onClick={() => void connectDiscovered(server)}
            >
              {connecting ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
      </article>
    );
  }

  function renderManualForm() {
    return (
      <form className="conn-manual" onSubmit={(event) => void submitManual(event)}>
        <ConnTabs value={manualTransport} change={(value) => { setManualTransport(value); clearPlacedMessage("manual"); }} label="Connection transport" />
        <label className="conn-field"><span>Name</span><input required maxLength={80} value={manualName} onChange={(event) => setManualName(event.target.value)} placeholder="Home server" /></label>
        {manualTransport === "tailscale" ? (
          <label className="conn-field"><span>Server address</span><input required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="wss://server.tailnet-name.ts.net:43717" /></label>
        ) : (
          <div className="conn-form-row">
            <label className="conn-field"><span>SSH host</span><input required value={sshHost} onChange={(event) => setSshHost(event.target.value)} placeholder="server.example or 100.x.y.z" /></label>
            <label className="conn-field"><span>SSH user</span><input value={sshUser} onChange={(event) => setSshUser(event.target.value)} placeholder="optional" /></label>
            <label className="conn-field port"><span>Access port</span><input required inputMode="numeric" value={sshPort} onChange={(event) => setSshPort(event.target.value)} /></label>
          </div>
        )}
        {manualTransport === "ssh" ? <p className="conn-note">TermLoop uses the system OpenSSH client and never auto-accepts a host key.</p> : null}
        {manualTransport === "tailscale" ? <p className="conn-note">The server must already have sharing enabled. Its identity is saved when you connect.</p> : null}
        <MessageBanner message={message?.placement === "manual" ? message : undefined} />
        <div className="conn-actions">
          <button type="submit" className="conn-primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
        </div>
      </form>
    );
  }

  function renderConnect() {
    const onlyLocal = profiles !== undefined && profiles.every((profile) => profile.transport === "local");
    const showEmptyDiscovery = discovery?.state !== "unavailable" && !discovery?.servers.length;
    return (
      <>
        <section className="conn-section" aria-labelledby="your-computers-title">
          <div className="conn-section-head"><h3 id="your-computers-title">Your computers</h3></div>
          {profiles === undefined ? (
            <div className="conn-list"><div className="conn-skeleton" /><div className="conn-skeleton" /></div>
          ) : (
            <div className="conn-list">{profiles.map(renderComputerCard)}</div>
          )}
          {onlyLocal ? <p className="conn-empty">Add a computer below to see its projects here too.</p> : null}
          <MessageBanner message={message && message.placement !== "discovered" && message.placement !== "manual" ? message : undefined} />
        </section>

        <section className="conn-section" aria-labelledby="discovery-title">
          <div className="conn-section-head">
            <div>
              <h3 id="discovery-title">On your Tailscale network</h3>
              <p className="conn-note">Computers with TermLoop sharing enabled appear here automatically. Connect with one click.</p>
            </div>
            <button className="conn-scan" type="button" disabled={discovering} onClick={() => void refreshDiscovery()}>
              <span className={discovering ? "conn-scan-spin" : "conn-scan-idle"} aria-hidden="true" />
              {discovering ? "Scanning…" : "Scan again"}
            </button>
          </div>

          {discovery?.state === "unavailable"
            ? <p className="conn-banner warning">{discovery.message ?? "Tailscale isn’t available on this computer."} You can still add a computer by address below.</p>
            : null}
          {discovery?.state === "ready" && discovery.message ? <p className="conn-banner warning">{discovery.message}</p> : null}

          {discovery?.servers.length ? (
            <>
              <div className="conn-list">{discovery.servers.map(renderDiscoveredCard)}</div>
              <MessageBanner message={message?.placement === "discovered" ? message : undefined} />
            </>
          ) : showEmptyDiscovery ? (
            <p className="conn-empty">{discovering
              ? "Looking for TermLoop computers on your tailnet…"
              : "No shared TermLoop computers found yet. On the other computer, open “Share this computer” and turn it on — it appears here automatically."}</p>
          ) : null}

          <details className="conn-advanced" onToggle={(event) => { if (!event.currentTarget.open) clearPlacedMessage("manual"); }}>
            <summary>Add by address instead</summary>
            {renderManualForm()}
          </details>
        </section>
      </>
    );
  }

  function renderShare() {
    const tailscaleOn = shareStatus?.tailscale.state === "ready";
    const on = shareTransport === "tailscale" ? tailscaleOn : !!shareStatus?.listening;
    const tailscaleIssue = shareStatus?.tailscale.state === "conflict" || shareStatus?.tailscale.state === "unavailable"
      ? shareStatus.tailscale.message
      : undefined;
    return (
      <section className="conn-section" aria-labelledby="share-title">
        <div className="conn-section-head">
          <div>
            <h3 id="share-title">Share this computer</h3>
            <p className="conn-note">Turn this on once. This computer then appears automatically in TermLoop on permitted computers.</p>
          </div>
          <ConnTabs value={shareTransport} change={setShareTransport} label="Sharing transport" />
        </div>

        {shareStatus === undefined && !shareMessage ? <p className="conn-empty">Checking this computer…</p> : (
          <>
            <div className="conn-share-hero">
              <div className="conn-status big">
                <StatusDot tone={on ? "ok" : shareBusy ? "warn" : "idle"} />
                <div className="conn-hero-text">
                  <strong>{on
                    ? shareTransport === "tailscale" ? "Visible on your Tailscale network" : "Remote access is on"
                    : shareBusy ? "Turning on…" : "Not shared yet"}</strong>
                  {tailscaleOn && shareTransport === "tailscale" && shareStatus?.tailscale.state === "ready" ? <small>{shareStatus.tailscale.baseUrl}</small> : null}
                  {shareStatus?.error || tailscaleIssue ? <small className="conn-warn-text">{shareStatus?.error ?? tailscaleIssue}</small> : null}
                </div>
              </div>
              <div className="conn-actions">
                {on ? (
                  <button type="button" className="conn-danger" disabled={shareBusy} onClick={() => void disableSharing()}>Stop sharing</button>
                ) : (
                  <button type="button" className="conn-primary" disabled={shareBusy} onClick={() => void enableSharing()}>{shareBusy ? "Turning on…" : "Make this computer reachable"}</button>
                )}
              </div>
            </div>

            {shareTransport === "tailscale"
              ? <p className="conn-note">TermLoop configures Tailscale Serve automatically. Anyone permitted by your tailnet ACLs can add this computer while sharing is on.</p>
              : <p className="conn-note">Remote Login/OpenSSH and trusted SSH keys must already work. An authenticated SSH user can add this computer while sharing is on.</p>}
            <p className="conn-note">Once connected, projects from this computer automatically appear under Remote Projects on your other computers.</p>
            <MessageBanner message={shareMessage} />
          </>
        )}
      </section>
    );
  }

  return (
    <div className="server-profiles-layer" role="presentation">
      <button className="server-profiles-backdrop" type="button" tabIndex={-1} aria-label="Close computers" onClick={close} />
      <section className="server-profiles-dialog" role="dialog" aria-modal="true" aria-labelledby="server-profiles-title">
        <header>
          <div><span>Remote Desktop</span><h2 id="server-profiles-title">Computers</h2></div>
          <button type="button" aria-label="Close" onClick={close}>×</button>
        </header>

        <div className="conn-toggle" role="group" aria-label="Connection settings">
          <button type="button" aria-pressed={view === "connect"} className={view === "connect" ? "active" : ""} onClick={() => setView("connect")}>Connect</button>
          <button type="button" aria-pressed={view === "share"} className={view === "share" ? "active" : ""} onClick={() => { setMessage(undefined); setView("share"); }}>Share this computer</button>
        </div>

        <div className="server-profiles-body">
          {view === "connect" ? renderConnect() : renderShare()}
        </div>
        <footer>Each connection creates a device credential that stays on the connecting computer and can be revoked from the server.</footer>
      </section>
    </div>
  );
}

export function mergeConnectionProfileStatuses(
  profiles: readonly ConnectionProfileSummary[],
  statuses: ReadonlyMap<string, ConnectionSourceSummary>,
): ConnectionProfileSummary[] {
  return profiles.map((profile) => {
    const status = statuses.get(profile.id);
    if (!status || !profile.enabled) return profile;
    const { message: _previousMessage, ...withoutMessage } = profile;
    return {
      ...withoutMessage,
      state: status.state,
      ...(status.message ? { message: status.message } : {}),
    };
  });
}

function profileStatus(profile: ConnectionProfileSummary): { tone: Tone; label: string } {
  if (!profile.enabled) return { tone: "idle", label: "Disabled" };
  switch (profile.state) {
    case "connected": return { tone: "ok", label: "Connected" };
    case "offline": return { tone: "danger", label: profile.message ? `Offline · ${profile.message}` : "Offline" };
    default: return { tone: "warn", label: "Connecting…" };
  }
}

function MessageBanner({ message }: { message: Message | undefined }) {
  if (!message) return null;
  return (
    <p className={`conn-banner ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
      {message.text}
    </p>
  );
}

function transportLabel(transport: ConnectionProfileSummary["transport"]): string {
  if (transport === "local") return "This computer";
  if (transport === "ssh") return "SSH";
  return "Tailscale";
}

function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`conn-dot ${tone}`} aria-hidden="true" />;
}

function VerifiedBadge() {
  return <span className="conn-verified" title="TermLoop protocol confirmed during discovery">✓ TermLoop</span>;
}

function ConnTabs({ value, change, label }: {
  value: "tailscale" | "ssh";
  change(value: "tailscale" | "ssh"): void;
  label: string;
}) {
  return (
    <div className="conn-tabs" role="group" aria-label={label}>
      <button type="button" className={value === "tailscale" ? "active" : ""} onClick={() => change("tailscale")}>Tailscale</button>
      <button type="button" className={value === "ssh" ? "active" : ""} onClick={() => change("ssh")}>SSH</button>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
