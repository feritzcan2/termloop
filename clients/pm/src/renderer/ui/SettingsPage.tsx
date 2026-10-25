import { useEffect, useState } from "react";
import type {
  PmAgentProvider,
  PmEnvironment,
  PmProbe,
  PmProbeMatcher,
  PmSettings,
  PmSettingsUpdateParams,
  PmSources,
  PmTracking,
} from "@termloop/pm-contract/pm";
import { relativeTime } from "./format.js";

export type JiraSourceDraft = { siteUrl: string; boardId: number | null; accountEmail: string; token: string };

export type SettingsPageProps = {
  projectName: string | undefined;
  settings: PmSettings | undefined;
  sources: PmSources | undefined;
  tracking: PmTracking | undefined;
  environments: PmEnvironment[];
  probes: PmProbe[];
  now: number;
  onSaveSources(jira: JiraSourceDraft | null, github: { owner: string; name: string } | null): Promise<boolean>;
  onClearToken(): void;
  onSaveSettings(edit: PmSettingsUpdateParams): void;
  onSetEnvironments(environments: PmEnvironment[]): void;
  onCreateProbe(environment: string, argv: string[], matcher: PmProbeMatcher): void;
  onApproveProbe(probeId: string): void;
  onRejectProbe(probeId: string): void;
  onDeleteProbe(probeId: string): void;
};

export function SettingsPage(props: SettingsPageProps) {
  if (!props.projectName) {
    return <section className="pm-settings"><p className="pm-hint">Create a project to configure its sources.</p></section>;
  }
  return (
    <section className="pm-settings" aria-label="Settings">
      <h2>Settings · {props.projectName}</h2>
      <SourcesCards {...props} />
      <DeployCard {...props} />
      <AgentCard settings={props.settings} onSave={props.onSaveSettings} />
      <section className="pm-card">
        <div className="pm-card-head"><h3>Data</h3></div>
        <p>All PM data lives in the local PM daemon's store at <code className="pm-mono">&lt;TermLoop state directory&gt;/pm/pm.sqlite</code>.</p>
        <p className="pm-hint">Jira API tokens are kept in the operating system's secure credential store, never in that file or in this window.</p>
      </section>
    </section>
  );
}

function SourcesCards(props: SettingsPageProps) {
  const jira = props.sources?.jira ?? null;
  const github = props.sources?.github ?? null;
  const [siteUrl, setSiteUrl] = useState(jira?.siteUrl ?? "");
  const [boardId, setBoardId] = useState(jira?.boardId?.toString() ?? "");
  const [accountEmail, setAccountEmail] = useState(jira?.accountEmail ?? "");
  // Write-only: the field starts empty and is cleared after every save.
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState(github?.owner ?? "");
  const [repository, setRepository] = useState(github?.name ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSiteUrl(jira?.siteUrl ?? "");
    setBoardId(jira?.boardId?.toString() ?? "");
    setAccountEmail(jira?.accountEmail ?? "");
    setOwner(github?.owner ?? "");
    setRepository(github?.name ?? "");
  }, [props.sources]);

  const jiraFilled = siteUrl.trim() !== "" || accountEmail.trim() !== "";
  const save = async () => {
    setSaving(true);
    const parsedBoard = boardId.trim() === "" ? null : Number(boardId.trim());
    const jiraDraft = jiraFilled
      ? { siteUrl: siteUrl.trim().replace(/\/+$/, ""), boardId: Number.isSafeInteger(parsedBoard) ? parsedBoard : null, accountEmail: accountEmail.trim(), token }
      : null;
    const githubDraft = owner.trim() && repository.trim() ? { owner: owner.trim(), name: repository.trim() } : null;
    try {
      await props.onSaveSources(jiraDraft, githubDraft);
    } finally {
      setToken("");
      setSaving(false);
    }
  };
  const jiraStatus = !jira ? "Not connected" : props.tracking?.jira ? "Connected" : "Configured";
  return (
    <form className="pm-settings-sources" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <section className="pm-card">
        <div className="pm-card-head"><h3>Jira</h3><span className="pm-muted">{jiraStatus}</span></div>
        <label className="pm-field"><span>Site</span><input placeholder="https://your-team.atlassian.net" value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} /></label>
        <label className="pm-field"><span>Board id</span><input inputMode="numeric" placeholder="e.g. 12" value={boardId} onChange={(event) => setBoardId(event.target.value.replace(/[^0-9]/g, ""))} /></label>
        <label className="pm-field"><span>Account email</span><input type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} /></label>
        <label className="pm-field">
          <span>API token</span>
          <input
            type="password"
            autoComplete="off"
            aria-label="Jira API token"
            placeholder={jira ? "Stored — type to replace" : "Paste an Atlassian API token"}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p className="pm-hint">
          {jira
            ? "A token is stored in the system credential store. It is never shown again."
            : "The token goes straight to the system credential store; this window never reads it back."}
          {jira && <> <button type="button" className="pm-link" onClick={props.onClearToken}>Remove stored token</button></>}
        </p>
      </section>
      <section className="pm-card">
        <div className="pm-card-head"><h3>GitHub</h3><span className="pm-muted">{github ? `${github.owner}/${github.name}` : "Not connected"}</span></div>
        <div className="pm-field-row">
          <label className="pm-field"><span>Owner</span><input value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          <label className="pm-field"><span>Repository</span><input value={repository} onChange={(event) => setRepository(event.target.value)} /></label>
        </div>
        {!props.tracking?.code && <p className="pm-hint">Connect a repository to see code stages (in review, merged) on tickets.</p>}
      </section>
      <div className="pm-card-foot">
        <button type="submit" className="pm-button primary" disabled={saving}>Save sources</button>
      </div>
    </form>
  );
}

function DeployCard(props: SettingsPageProps) {
  const [environments, setEnvironments] = useState<PmEnvironment[]>(props.environments);
  const [newEnvironment, setNewEnvironment] = useState("");
  const [probeEnvironment, setProbeEnvironment] = useState("");
  const [probeCommand, setProbeCommand] = useState("");
  const [probeMatcher, setProbeMatcher] = useState<PmProbeMatcher>("commitAncestry");
  useEffect(() => setEnvironments(props.environments), [props.environments]);
  const dirty = JSON.stringify(environments) !== JSON.stringify(props.environments);
  const move = (index: number, delta: number) => {
    const next = [...environments];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    setEnvironments(next);
  };
  const on = props.tracking?.deploy ?? false;
  return (
    <section className="pm-card">
      <div className="pm-card-head"><h3>Deploy tracking</h3><span className="pm-muted">{on ? "On" : "Off"}</span></div>
      <p className="pm-hint">
        Deploy tracking is on whenever this project has an environment or an approved probe, and off when it has neither. There is no separate switch.
      </p>
      <h4>Environments <span className="pm-muted">(in promotion order)</span></h4>
      <ol className="pm-env-list">
        {environments.map((environment, index) => (
          <li key={`${environment.name}-${index}`}>
            <span className="pm-mono">{environment.name}</span>
            <label><input type="checkbox" checked={environment.production} onChange={(event) => setEnvironments(environments.map((item, at) => at === index ? { ...item, production: event.target.checked } : item))} /> production</label>
            <button type="button" className="pm-icon-button" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="pm-icon-button" aria-label="Move down" disabled={index === environments.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button type="button" className="pm-icon-button" aria-label="Remove environment" onClick={() => setEnvironments(environments.filter((_, at) => at !== index))}>×</button>
          </li>
        ))}
      </ol>
      <form className="pm-inline-form" onSubmit={(event) => {
        event.preventDefault();
        if (!newEnvironment.trim()) return;
        setEnvironments([...environments, { name: newEnvironment.trim(), production: false }]);
        setNewEnvironment("");
      }}>
        <input placeholder="Add environment (e.g. staging)" aria-label="New environment" value={newEnvironment} onChange={(event) => setNewEnvironment(event.target.value)} />
        <button type="submit" className="pm-button">Add</button>
        <button type="button" className="pm-button primary" disabled={!dirty} onClick={() => props.onSetEnvironments(environments)}>Save environments</button>
      </form>
      <h4>Probes</h4>
      {props.probes.length === 0 ? <p className="pm-hint">No probes. A probe is a command that tells which commit runs in an environment; the agent may propose one for your approval.</p> : (
        <ul className="pm-probe-list">
          {props.probes.map((probe) => (
            <li key={probe.id}>
              <div>
                <span className="pm-mono">{probe.environment}</span> <code className="pm-mono">{probe.argv.join(" ")}</code>
                <span className={`pm-pill probe-${probe.status}`}>{probe.status === "proposed" ? "Proposed" : "Approved"}</span>
                <span className="pm-muted">{probe.matcher} · by {probe.author === "agent" ? "agent" : "you"}</span>
              </div>
              {probe.reason && <p className="pm-hint">{probe.reason}</p>}
              {probe.lastRun && <p className="pm-hint">Last run {relativeTime(probe.lastRun.atEpochMs, props.now)}{probe.lastRun.failure ? ` — failed: ${probe.lastRun.failure}` : probe.lastRun.deployedCommit ? ` — ${probe.lastRun.deployedCommit.slice(0, 10)}` : ""}</p>}
              <div className="pm-probe-actions">
                {probe.status === "proposed" ? (
                  <>
                    <button type="button" className="pm-button" onClick={() => props.onRejectProbe(probe.id)}>Reject</button>
                    <button type="button" className="pm-button primary" onClick={() => props.onApproveProbe(probe.id)}>Approve</button>
                  </>
                ) : <button type="button" className="pm-button ghost" onClick={() => props.onDeleteProbe(probe.id)}>Delete</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {props.environments.length > 0 ? (
        <form className="pm-inline-form" onSubmit={(event) => {
          event.preventDefault();
          const argv = probeCommand.trim().split(/\s+/).filter(Boolean);
          const environment = probeEnvironment || props.environments[0]!.name;
          if (argv.length === 0) return;
          props.onCreateProbe(environment, argv, probeMatcher);
          setProbeCommand("");
        }}>
          <select aria-label="Probe environment" value={probeEnvironment} onChange={(event) => setProbeEnvironment(event.target.value)}>
            {props.environments.map((environment) => <option key={environment.name} value={environment.name}>{environment.name}</option>)}
          </select>
          <input placeholder="Command, e.g. curl -s https://app/version" aria-label="Probe command" value={probeCommand} onChange={(event) => setProbeCommand(event.target.value)} />
          <select aria-label="Probe matcher" value={probeMatcher} onChange={(event) => setProbeMatcher(event.target.value as PmProbeMatcher)}>
            <option value="commitAncestry">Commit ancestry</option>
            <option value="agent">Agent reads output</option>
          </select>
          <button type="submit" className="pm-button">Add probe</button>
        </form>
      ) : <p className="pm-hint">Add an environment to define probes for it.</p>}
    </section>
  );
}

function AgentCard(props: { settings: PmSettings | undefined; onSave(edit: PmSettingsUpdateParams): void }) {
  const [provider, setProvider] = useState<PmAgentProvider>(props.settings?.agentProvider ?? "claude");
  const [model, setModel] = useState(props.settings?.agentModel ?? "");
  const [permission, setPermission] = useState(props.settings?.assistantPermission ?? "");
  useEffect(() => {
    if (!props.settings) return;
    setProvider(props.settings.agentProvider);
    setModel(props.settings.agentModel);
    setPermission(props.settings.assistantPermission);
  }, [props.settings]);
  if (!props.settings) return <section className="pm-card"><div className="pm-card-head"><h3>Agent</h3></div><p className="pm-hint">Loading agent settings…</p></section>;
  return (
    <section className="pm-card">
      <div className="pm-card-head"><h3>Agent</h3><span className="pm-muted">Applies to every project</span></div>
      <div className="pm-field-row">
        <label className="pm-field"><span>Provider</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value as PmAgentProvider)}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label className="pm-field"><span>Model</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
      </div>
      <div className="pm-field-row">
        <label className="pm-field"><span>PM agent permission</span><input value={permission} onChange={(event) => setPermission(event.target.value)} /></label>
        <label className="pm-field"><span>Delivery check permission</span><input value={props.settings.checkPermission} readOnly /></label>
      </div>
      <p className="pm-hint">Delivery checks run unattended, so their permission is fixed. Unknown models or permissions are refused by the daemon.</p>
      <div className="pm-card-foot">
        <button type="button" className="pm-button primary" onClick={() => props.onSave({ agentProvider: provider, agentModel: model.trim(), assistantPermission: permission.trim() })}>Save agent settings</button>
      </div>
    </section>
  );
}
