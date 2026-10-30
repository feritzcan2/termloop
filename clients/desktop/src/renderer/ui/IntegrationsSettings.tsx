import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  IntegrationAzureDevOpsTokenSetParams,
  IntegrationAzureDevOpsTokenSetResult,
  IntegrationStatusDto,
  IntegrationStatusListParams,
  IntegrationStatusListResult,
} from "@termloop/contract/current";

import type { ConnectionProfileSummary } from "../../connection-profile-types.js";
import { connectionStatusSuffix } from "../connection-source-status.js";
import {
  groupIntegrations,
  integrationCapabilityLabel,
  integrationCheckedLabel,
  integrationCredentialSourceLabel,
  integrationErrorMessage,
  integrationMethodUnavailable,
  integrationProviderLabel,
  integrationRemediation,
  integrationRetryAfterLabel,
  integrationStateCopy,
  type IntegrationHintPart,
} from "../integration-status.js";
import { computerScopeName, hasRemoteComputers } from "../settings-scope.js";
import "./integrations.css";

/** Integration status lives on each daemon, so every action names the computer
    it asks. The composition root binds these to that computer's source API. */
export type IntegrationActions = {
  list(profileId: string, params: IntegrationStatusListParams): Promise<IntegrationStatusListResult>;
  setAzureDevOpsToken(
    profileId: string,
    params: IntegrationAzureDevOpsTokenSetParams,
  ): Promise<IntegrationAzureDevOpsTokenSetResult>;
};

const AZURE_TOKEN_MAX_BYTES = 1024;

export function IntegrationsSettings({
  actions,
  listProfiles,
  initialProfileId = "local",
  openTaskSettings,
  nowEpochMs,
}: {
  actions: IntegrationActions;
  listProfiles(): Promise<ConnectionProfileSummary[]>;
  initialProfileId?: string | undefined;
  /** Opens the selected Project's Task Settings, where Jira sites are added. */
  openTaskSettings?: (() => void) | undefined;
  /** Injected by tests so relative times are not read off the wall clock. */
  nowEpochMs?: number | undefined;
}) {
  const [profiles, setProfiles] = useState<ConnectionProfileSummary[]>();
  const [profilesError, setProfilesError] = useState<string>();
  const [selectedProfileId, setSelectedProfileId] = useState(initialProfileId);
  useEffect(() => {
    let active = true;
    void listProfiles().then(
      (next) => { if (active) { setProfiles(next); setProfilesError(undefined); } },
      (cause) => { if (active) setProfilesError(integrationErrorMessage(cause)); },
    );
    return () => { active = false; };
  }, [listProfiles]);
  const profile = profiles?.find((candidate) => candidate.id === selectedProfileId)
    ?? profiles?.find((candidate) => candidate.id === "local")
    ?? profiles?.[0];
  const multiple = (profiles?.length ?? 0) > 1;
  return <section className="integrations-settings" aria-labelledby="integrations-settings-title">
    <div className="settings-page-header">
      <h3 id="integrations-settings-title">Integrations</h3>
      <p>Pull request, build check, and issue providers that TermLoop reads on each computer. Credentials stay on that computer.</p>
    </div>
    {profiles && multiple ? <label className="conn-field agent-server-select"><span>Computer</span>
      <select aria-label="Computer" value={profile?.id ?? ""} onChange={(event) => setSelectedProfileId(event.target.value)}>
        {profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>
          {candidate.name}{connectionStatusSuffix(candidate.state, candidate.message)}
        </option>)}
      </select>
    </label> : null}
    {profilesError ? <p className="settings-error" role="alert">Could not load computers: {profilesError}</p>
      : !profiles ? <p className="settings-loading" role="status">Loading computers…</p>
      : !profile ? <p className="settings-empty">No computer is available.</p>
      : <ComputerIntegrations
        key={profile.id}
        profile={profile}
        scopeName={hasRemoteComputers(profiles) || profile.transport !== "local"
          ? computerScopeName(profile.name, profile.transport === "local")
          : undefined}
        actions={actions}
        openTaskSettings={openTaskSettings}
        nowEpochMs={nowEpochMs}
      />}
  </section>;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; integrations: IntegrationStatusDto[] }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

export function ComputerIntegrations({
  profile,
  scopeName,
  actions,
  openTaskSettings,
  nowEpochMs,
}: {
  profile: ConnectionProfileSummary;
  scopeName?: string | undefined;
  actions: IntegrationActions;
  openTaskSettings?: (() => void) | undefined;
  nowEpochMs?: number | undefined;
}) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const generation = useRef(0);
  const mounted = useRef(true);
  const loaded = useRef(false);
  useEffect(() => { loaded.current = load.kind === "ready"; }, [load.kind]);
  const canManage = profile.scope !== "readOnly" && profile.enabled
    && (profile.transport === "local" || profile.state === "connected");

  const fetchStatus = useCallback(async (refresh: boolean) => {
    if (!canManage) return;
    const request = ++generation.current;
    if (refresh) { setRefreshing(true); setRefreshError(undefined); }
    try {
      const result = await actions.list(profile.id, { refresh });
      if (!mounted.current || request !== generation.current) return;
      setLoad({ kind: "ready", integrations: result.integrations });
      setRefreshError(undefined);
    } catch (cause) {
      if (!mounted.current || request !== generation.current) return;
      if (integrationMethodUnavailable(cause)) setLoad({ kind: "unsupported" });
      // A failed refresh keeps the last answer on screen and says why above it.
      else if (loaded.current) setRefreshError(integrationErrorMessage(cause));
      else setLoad({ kind: "error", message: integrationErrorMessage(cause) });
    } finally {
      if (mounted.current && request === generation.current) setRefreshing(false);
    }
  }, [actions, canManage, profile.id]);

  useEffect(() => {
    mounted.current = true;
    void fetchStatus(false);
    return () => { mounted.current = false; generation.current += 1; };
  }, [fetchStatus]);

  const replaceStatus = useCallback((status: IntegrationStatusDto) => {
    generation.current += 1;
    setRefreshing(false);
    setLoad((current) => {
      if (current.kind !== "ready") return { kind: "ready", integrations: [status] };
      const index = current.integrations.findIndex((value) => value.provider === status.provider && value.target === status.target);
      const fallback = index >= 0 ? index : current.integrations.findIndex((value) => value.provider === status.provider);
      const integrations = [...current.integrations];
      if (fallback >= 0) integrations[fallback] = status;
      else integrations.push(status);
      return { kind: "ready", integrations };
    });
  }, []);

  const refresh = () => void fetchStatus(true);
  const now = nowEpochMs ?? Date.now();
  const groups = load.kind === "ready" ? groupIntegrations(load.integrations) : undefined;
  const azure = groups?.azureDevOps ?? [];
  return <div className="integrations-computer" aria-label={`Integrations on ${profile.name}`}>
    {scopeName ? <p className="settings-scope-label">Computer: {scopeName}</p> : null}
    {!canManage ? <p className="conn-banner warning">{profile.scope === "readOnly"
      ? "Full access to this computer is required to check its integrations."
      : `Connect to ${profile.name} to check its integrations.`}</p>
      : load.kind === "loading" ? <p className="settings-loading" role="status">Checking integrations on {profile.name}…</p>
      : load.kind === "unsupported" ? <p className="conn-banner warning" role="alert">{integrationErrorMessage(new Error("method not found"))}</p>
      : load.kind === "error" ? <div className="conn-banner error integrations-load-error" role="alert">
        <p>Could not check integrations: {load.message}</p>
        <button type="button" className="conn-scan" disabled={refreshing} onClick={refresh}>{refreshing ? "Checking…" : "Retry"}</button>
      </div>
      : groups ? <>
        {refreshError ? <p className="conn-banner error" role="alert">Refresh failed: {refreshError}</p> : null}
        <section className="integrations-section" aria-labelledby="integrations-review-title">
          <header>
            <h4 id="integrations-review-title">Review providers</h4>
            <p>Pull requests, build checks, reviews, and merge conflicts for Task branches. Playbook steps can check these directly.</p>
          </header>
          <div className="integrations-cards">
            {groups.github.length === 0
              ? <MissingIntegrationCard provider="GitHub" />
              : groups.github.map((status) => <IntegrationCard key={`github:${status.target}`} status={status}
                now={now} refreshing={refreshing} refresh={refresh} />)}
            {azure.length === 0
              ? <MissingIntegrationCard provider="Azure DevOps">
                <AzureTokenForm profileId={profile.id} actions={actions} accepted={replaceStatus} />
              </MissingIntegrationCard>
              : azure.map((status, index) => <IntegrationCard key={`azureDevOps:${status.target}`} status={status}
                now={now} refreshing={refreshing} refresh={refresh}>
                {/* The PAT is one per computer, not per organization. */}
                {index === 0 ? <AzureTokenForm profileId={profile.id} actions={actions} accepted={replaceStatus}
                  hasSavedToken={status.credentialSource === "personalAccessToken"} /> : null}
              </IntegrationCard>)}
          </div>
        </section>
        <section className="integrations-section" aria-labelledby="integrations-task-title">
          <header>
            <h4 id="integrations-task-title">Task providers</h4>
            <p>Issue trackers that Projects on this computer import Tasks from.</p>
          </header>
          <div className="integrations-cards">
            {groups.jira.length === 0 ? <div className="integrations-empty">
              <p>No Jira site is connected on this computer. Add one from a Project&apos;s Task Settings; it appears here once connected.</p>
              {openTaskSettings ? <button type="button" className="conn-manage" onClick={openTaskSettings}>Open Task Settings</button> : null}
            </div> : groups.jira.map((status) => <IntegrationCard key={`jira:${status.target}`} status={status}
              now={now} refreshing={refreshing} refresh={refresh} />)}
          </div>
        </section>
      </> : null}
  </div>;
}

function MissingIntegrationCard({ provider, children }: { provider: string; children?: ReactNode }) {
  return <article className="integration-card" aria-label={`${provider} integration`}>
    <header>
      <div className="integration-card-title"><h5>{provider}</h5></div>
      <span className="integration-state idle">Not reported</span>
    </header>
    <p className="conn-note">This computer did not report {provider}. Update its TermLoop server, then refresh.</p>
    {children}
  </article>;
}

export function IntegrationCard({
  status,
  now,
  refreshing,
  refresh,
  children,
}: {
  status: IntegrationStatusDto;
  now: number;
  refreshing: boolean;
  refresh(): void;
  children?: ReactNode;
}) {
  const provider = integrationProviderLabel(status.provider);
  const state = integrationStateCopy(status.state);
  const credential = integrationCredentialSourceLabel(status.credentialSource);
  const retry = status.state === "rateLimited" ? integrationRetryAfterLabel(status, now) : undefined;
  const hint = integrationRemediation(status);
  return <article className="integration-card" aria-label={`${provider} ${status.target}`} data-state={status.state}>
    <header>
      <div className="integration-card-title">
        <h5>{provider}</h5>
        <small>{status.target}</small>
      </div>
      <span className={`integration-state ${state.tone}`}>{state.label}</span>
    </header>
    {status.account || credential ? <dl className="integration-facts">
      {status.account ? <div><dt>Account</dt><dd>{status.account}</dd></div> : null}
      {credential ? <div><dt>Credential</dt><dd>{credential}</dd></div> : null}
    </dl> : null}
    {status.capabilities.length > 0 ? <ul className="integration-capabilities" aria-label={`${provider} capabilities`}>
      {status.capabilities.map((value) => <li key={value.capability}
        className={value.available ? "available" : "unavailable"}
        title={value.available ? "Available" : "Not available"}>
        <span aria-hidden="true">{value.available ? "✓" : "–"}</span>
        {integrationCapabilityLabel(value.capability)}
        <span className="visually-hidden">{value.available ? " (available)" : " (unavailable)"}</span>
      </li>)}
    </ul> : null}
    {hint ? <p className="integration-hint">{renderHint(hint)}</p> : null}
    {children}
    <footer>
      <small>{[retry, integrationCheckedLabel(status.checkedAtEpochMs, now)].filter(Boolean).join(" · ")}</small>
      <button type="button" className="conn-scan" disabled={refreshing}
        aria-label={`Refresh ${provider} ${status.target}`} onClick={refresh}>{refreshing ? "Checking…" : "Refresh"}</button>
    </footer>
  </article>;
}

function renderHint(parts: readonly IntegrationHintPart[]) {
  return parts.map((part, index) => typeof part === "string" ? part : <code key={index}>{part.code}</code>);
}

/** The PAT exists only in this input until Save sends it to the selected
    daemon. Nothing else in the renderer holds it, and it is cleared once the
    daemon accepts it. */
export function AzureTokenForm({
  profileId,
  actions,
  accepted,
  hasSavedToken = false,
}: {
  profileId: string;
  actions: IntegrationActions;
  accepted(status: IntegrationStatusDto): void;
  hasSavedToken?: boolean;
}) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<"save" | "remove">();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const tooLong = new TextEncoder().encode(token).length > AZURE_TOKEN_MAX_BYTES;
  const submit = async (next: string | null) => {
    setPending(next === null ? "remove" : "save"); setError(undefined); setSaved(undefined);
    try {
      const result = await actions.setAzureDevOpsToken(profileId, { token: next });
      if (!alive.current) return;
      setToken("");
      setSaved(next === null ? "Personal access token removed." : "Personal access token saved.");
      accepted(result.status);
    } catch (cause) {
      if (alive.current) setError(integrationErrorMessage(cause));
    } finally {
      if (alive.current) setPending(undefined);
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value || tooLong || pending) return;
    void submit(value);
  };
  return <form className="integration-token-form" onSubmit={onSubmit} aria-label="Azure DevOps personal access token">
    <label className="conn-field"><span>Personal access token</span>
      <input type="password" autoComplete="off" spellCheck={false} value={token}
        placeholder={hasSavedToken ? "Saved · paste a new token to replace it" : "Paste a token with Code (read) access"}
        aria-label="Azure DevOps personal access token"
        onChange={(event) => setToken(event.target.value)} />
    </label>
    <div className="integration-token-actions">
      <button type="submit" className="conn-primary small" disabled={!token.trim() || tooLong || pending !== undefined}>
        {pending === "save" ? "Saving…" : "Save"}</button>
      <button type="button" className="conn-danger small" disabled={pending !== undefined}
        onClick={() => void submit(null)}>{pending === "remove" ? "Removing…" : "Remove"}</button>
    </div>
    {tooLong ? <p className="conn-banner error" role="alert">The token is too long (max {AZURE_TOKEN_MAX_BYTES} bytes).</p> : null}
    {error ? <p className="conn-banner error" role="alert">{error}</p> : null}
    {saved ? <p className="conn-banner success" role="status">{saved}</p> : null}
    <p className="conn-note">Stored in this computer&apos;s secure credential store and used instead of <code>az login</code>. Needs Code (read) and Build (read) scopes.</p>
  </form>;
}
