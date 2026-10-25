import { useEffect, useState, type ReactNode } from "react";
import type {
  PmAgentCatalog,
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
  catalog: PmAgentCatalog | undefined;
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
    return (
      <section className="pane" aria-label="Settings">
        <div className="pane-head"><b>Settings</b></div>
        <div className="body"><p className="hint">Create a project to configure its sources.</p></div>
      </section>
    );
  }
  return (
    <section className="pane settings-pane" aria-label="Settings">
      <div className="pane-head"><b>Settings</b><span className="meta">{props.projectName}</span><span className="sp" /></div>
      <div className="body">
        <SourcesCards {...props} />
        <DeployCard {...props} />
        <AgentCard settings={props.settings} catalog={props.catalog} onSave={props.onSaveSettings} />
        <SettingsSection title="Your data" description={<>Everything lives on this computer in the PM daemon's store at <code>&lt;TermLoop state directory&gt;/pm/pm.sqlite</code>. There is no server and no account.</>}>
          <p className="hint">Jira API tokens are kept in the operating system's secure credential store, never in that file or in this window.</p>
        </SettingsSection>
      </div>
    </section>
  );
}

function SettingsSection(props: { title: string; state?: { tone: "ok" | "warn" | "off"; text: string }; description: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={props.title}>
      <div className="settings-title">
        <h3>{props.title}</h3>
        {props.state && <span className={`state ${props.state.tone}`}><i />{props.state.text}</span>}
      </div>
      <p className="settings-desc">{props.description}</p>
      {props.children}
    </section>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return <label className="field"><span>{props.label}</span>{props.children}</label>;
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
  const jiraState = !jira
    ? { tone: "off" as const, text: "NOT CONNECTED" }
    : props.tracking?.jira ? { tone: "ok" as const, text: "CONNECTED" } : { tone: "warn" as const, text: "CONFIGURED" };
  return (
    <form className="settings-sources" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SettingsSection title="Jira" state={jiraState} description="Tickets and sprints are mirrored from the board below. Changes you confirm in the Write to Jira dialog are written back to Jira.">
        <div className="fields">
          <Field label="Site"><input placeholder="https://your-team.atlassian.net" value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} /></Field>
          <Field label="Board"><input inputMode="numeric" placeholder="Board id, e.g. 12" value={boardId} onChange={(event) => setBoardId(event.target.value.replace(/[^0-9]/g, ""))} /></Field>
          <Field label="Account"><input type="email" placeholder="you@example.com" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} /></Field>
          <Field label="API token">
            <input
              type="password"
              autoComplete="off"
              aria-label="Jira API token"
              placeholder={jira ? "Stored. Type to replace" : "Paste an Atlassian API token"}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
        </div>
        <p className="hint">
          {jira
            ? "A token is stored in the system credential store. It is never shown again, and only ever sent to Jira."
            : "The token goes straight to the system credential store; this window never reads it back."}
        </p>
      </SettingsSection>
      <SettingsSection
        title="GitHub"
        state={github ? { tone: "ok", text: "CONNECTED" } : { tone: "off", text: "NOT CONNECTED" }}
        description="Pull requests are matched to tickets by their issue key. The app reads review state and how long a pull request has been waiting."
      >
        <div className="fields">
          <Field label="Owner"><input placeholder="e.g. acme" value={owner} onChange={(event) => setOwner(event.target.value)} /></Field>
          <Field label="Repository"><input placeholder="e.g. shop" value={repository} onChange={(event) => setRepository(event.target.value)} /></Field>
        </div>
        {!props.tracking?.code && <p className="hint">Connect a repository to see code stages (in review, merged) on tickets.</p>}
        <div className="actions">
          <button type="submit" className="btn pri" disabled={saving}>Save connections</button>
          {jira && <button type="button" className="btn ghost" onClick={props.onClearToken}>Remove stored token</button>}
        </div>
      </SettingsSection>
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
  const unprobed = props.environments.filter((environment) => !props.probes.some((probe) => probe.environment === environment.name && probe.status === "approved")).length;
  const state = !on
    ? { tone: "off" as const, text: "OFF" }
    : { tone: unprobed > 0 ? "warn" as const : "ok" as const, text: `${props.environments.length} ${props.environments.length === 1 ? "ENVIRONMENT" : "ENVIRONMENTS"}${unprobed > 0 ? ` · ${unprobed} WITHOUT A PROBE` : ""}` };
  return (
    <SettingsSection
      title="Deploy tracking"
      state={state}
      description="Deploy tracking is on whenever this project has an environment or an approved probe, and off when it has neither. There is no separate switch."
    >
      <div className="sub-label">Environments <span className="muted">in promotion order</span></div>
      <ol className="env-list">
        {environments.map((environment, index) => (
          <li key={`${environment.name}-${index}`}>
            <b>{environment.name}</b>
            <label className="check"><input type="checkbox" checked={environment.production} onChange={(event) => setEnvironments(environments.map((item, at) => at === index ? { ...item, production: event.target.checked } : item))} /> production</label>
            <span className="sp" />
            <button type="button" className="icb" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="icb" aria-label="Move down" disabled={index === environments.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button type="button" className="icb" aria-label="Remove environment" onClick={() => setEnvironments(environments.filter((_, at) => at !== index))}>×</button>
          </li>
        ))}
        {environments.length === 0 && <li className="muted">No environments.</li>}
      </ol>
      <form className="inline-form" onSubmit={(event) => {
        event.preventDefault();
        if (!newEnvironment.trim()) return;
        setEnvironments([...environments, { name: newEnvironment.trim(), production: false }]);
        setNewEnvironment("");
      }}>
        <input placeholder="Add environment (e.g. staging)" aria-label="New environment" value={newEnvironment} onChange={(event) => setNewEnvironment(event.target.value)} />
        <button type="submit" className="btn">Add environment</button>
        <button type="button" className="btn pri" disabled={!dirty} onClick={() => props.onSetEnvironments(environments)}>Save environments</button>
      </form>
      <div className="sub-label">Probes</div>
      {props.probes.length === 0 ? <p className="hint">No probes. A probe is a command that tells which commit runs in an environment; the assistant may propose one for your approval.</p> : (
        <ul className="probe-list">
          {props.probes.map((probe) => (
            <li key={probe.id}>
              <b>{probe.environment}</b>
              <span className="probe-body">
                <code>{probe.argv.join(" ")}</code>
                <span className="muted"> · {probe.matcher} · by {probe.author === "agent" ? "assistant" : "you"}</span>
                {probe.reason && <span className="hint block">{probe.reason}</span>}
                {probe.lastRun && <span className="hint block">Last run {relativeTime(probe.lastRun.atEpochMs, props.now)}{probe.lastRun.failure ? `, failed: ${probe.lastRun.failure}` : probe.lastRun.deployedCommit ? `, ${probe.lastRun.deployedCommit.slice(0, 10)}` : ""}</span>}
              </span>
              <span className={`chip ${probe.status === "proposed" ? "warn" : ""}`}>{probe.status === "proposed" ? "proposed" : "approved"}</span>
              <span className="probe-actions">
                {probe.status === "proposed" ? (
                  <>
                    <button type="button" className="btn sm" onClick={() => props.onRejectProbe(probe.id)}>Reject</button>
                    <button type="button" className="btn sm pri" onClick={() => props.onApproveProbe(probe.id)}>Approve</button>
                  </>
                ) : <button type="button" className="btn sm ghost" onClick={() => props.onDeleteProbe(probe.id)}>Delete</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {props.environments.length > 0 ? (
        <form className="inline-form" onSubmit={(event) => {
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
            <option value="agent">Assistant reads output</option>
          </select>
          <button type="submit" className="btn">Add probe</button>
        </form>
      ) : <p className="hint">Add an environment to define probes for it.</p>}
    </SettingsSection>
  );
}

/** Keeps `value` selectable even when the catalog no longer lists it. */
function choices(options: readonly string[], value: string): string[] {
  return value && !options.includes(value) ? [value, ...options] : [...options];
}

function AgentCard(props: { settings: PmSettings | undefined; catalog: PmAgentCatalog | undefined; onSave(edit: PmSettingsUpdateParams): void }) {
  const [provider, setProvider] = useState<PmAgentProvider>(props.settings?.agentProvider ?? "claude");
  const [model, setModel] = useState(props.settings?.agentModel ?? "");
  const [permission, setPermission] = useState(props.settings?.assistantPermission ?? "");
  const [checkPermission, setCheckPermission] = useState(props.settings?.checkPermission ?? "");
  useEffect(() => {
    if (!props.settings) return;
    setProvider(props.settings.agentProvider);
    setModel(props.settings.agentModel);
    setPermission(props.settings.assistantPermission);
    setCheckPermission(props.settings.checkPermission);
  }, [props.settings]);
  const description = "The assistant drafts summaries, descriptions and checks. It never writes to Jira or any other system; you apply every change yourself. These choices apply to every project.";
  if (!props.settings || !props.catalog) return <SettingsSection title="Assistant" description={description}><p className="hint">Loading assistant settings…</p></SettingsSection>;
  const providers = props.catalog.providers;
  const entry = providers.find((candidate) => candidate.id === provider);
  const models = entry?.models ?? [];
  const assistant = entry?.permissions.assistant ?? [];
  const check = entry?.permissions.check ?? [];
  const changeProvider = (next: PmAgentProvider) => {
    // Another provider's names mean nothing here; start from its first choices.
    const nextEntry = providers.find((candidate) => candidate.id === next);
    setProvider(next);
    setModel(nextEntry?.models[0] ?? "");
    setPermission(nextEntry?.permissions.assistant[0] ?? "");
    setCheckPermission(nextEntry?.permissions.check[0] ?? "");
  };
  return (
    <SettingsSection title="Assistant" description={description}>
      <div className="fields">
        <Field label="Provider">
          <select aria-label="Agent provider" value={provider} onChange={(event) => changeProvider(event.target.value as PmAgentProvider)}>
            {providers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
          </select>
        </Field>
        <Field label="Model">
          <select aria-label="Agent model" value={model} onChange={(event) => setModel(event.target.value)}>
            {choices(models, model).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <Field label="Working with you">
          <select aria-label="PM agent permission" value={permission} onChange={(event) => setPermission(event.target.value)}>
            {choices(assistant, permission).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <Field label="Delivery checks">
          <select aria-label="Delivery check permission" value={checkPermission} disabled={check.length <= 1} onChange={(event) => setCheckPermission(event.target.value)}>
            {choices(check, checkPermission).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
      </div>
      <p className="hint">Choices come from the agent catalog the daemon knows. Delivery checks run on their own in the background, so only modes that do not wait for an answer are offered for them.</p>
      <div className="actions">
        <button
          type="button"
          className="btn pri"
          disabled={!model || !permission || !checkPermission}
          onClick={() => props.onSave({ agentProvider: provider, agentModel: model, assistantPermission: permission, checkPermission })}
        >
          Save agent settings
        </button>
      </div>
    </SettingsSection>
  );
}
