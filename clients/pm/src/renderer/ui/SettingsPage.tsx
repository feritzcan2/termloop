import { useEffect, useState, type ReactNode } from "react";
import type {
  PmAgentCatalog,
  PmAgentProvider,
  PmPlaybook,
  PmPlaybookStep,
  PmSettings,
  PmSettingsUpdateParams,
  PmSources,
  PmToolsReadResult,
  PmTracking,
} from "@termloop/pm-contract/pm";
import { PlaybookStepsEditor, stepsProblem, tidySteps } from "./PlaybookEditor.js";
import { ToolsChecklist } from "./ToolsChecklist.js";

export type JiraSourceDraft = { siteUrl: string; boardId: number | null; accountEmail: string; token: string };

export type SettingsPageProps = {
  projectName: string;
  projectFolder?: string | null;
  settings: PmSettings | undefined;
  catalog: PmAgentCatalog | undefined;
  sources: PmSources | undefined;
  tracking: PmTracking | undefined;
  /** The project's Playbook; absent until the board is read. */
  playbook: PmPlaybook | undefined;
  tools: PmToolsReadResult | undefined;
  now: number;
  /** Reads the tools checklist; `refresh` checks the machine again. */
  onReadTools(refresh: boolean): Promise<void>;
  onSaveSources(jira: JiraSourceDraft | null): Promise<boolean>;
  onClearToken(): void;
  onPickFolder?(): Promise<string | null>;
  onSetFolder?(folder: string | null): void;
  /** Deletes the open project and everything stored for it. */
  onDeleteProject?(): void;
  onSaveSettings(edit: PmSettingsUpdateParams): void;
  /** Resolves true once saved over `baseRevision`. */
  onSavePlaybook(baseRevision: number, steps: PmPlaybookStep[]): Promise<boolean>;
  /** Starts the agent that reads the repository and proposes the Playbook. */
  onCreatePlaybook(): void;
};

/** The Settings stage, opened from the activity bar: the open project's sources and the app-wide assistant. */
export function SettingsPage(props: SettingsPageProps) {
  return (
    <section className="pane settings-pane" aria-label="Settings">
      <div className="pane-head"><b>Settings</b><span className="meta">{props.projectName}</span><span className="sp" /></div>
      <div className="body">
        <div className="settings-column">
          <CodeRepositoryCard {...props} />
          <JiraCard {...props} />
          <PlaybookCard playbook={props.playbook} onSave={props.onSavePlaybook} onCreate={props.onCreatePlaybook} />
          <AgentCard settings={props.settings} catalog={props.catalog} onSave={props.onSaveSettings} />
          <ToolsCard tools={props.tools} now={props.now} onRead={props.onReadTools} />
          <SettingsSection title="Your data" description={<>Everything lives on this computer in the PM daemon's store at <code>&lt;TermLoop state directory&gt;/pm/pm.sqlite</code>. There is no server and no account.</>}>
            <p className="hint">Jira API tokens are kept in the operating system's secure credential store, never in that file or in this window.</p>
          </SettingsSection>
          {props.onDeleteProject && <DeleteProjectCard projectName={props.projectName} onDelete={props.onDeleteProject} />}
        </div>
      </div>
    </section>
  );
}

export function DeleteProjectCard(props: { projectName: string; onDelete(): void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingsSection title="Delete project" description="Removes this project from this computer: its sprints, tickets, notes, Playbook, skills and sources. Its running agents are stopped. Nothing in Jira or the code repository changes.">
      {confirming ? (
        <div className="card" role="dialog" aria-label="Delete project">
          <p>Delete <strong>{props.projectName}</strong> and everything stored for it? This cannot be undone.</p>
          <div className="card-foot">
            <button type="button" className="btn sm ghost" onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn sm pri" onClick={() => { setConfirming(false); props.onDelete(); }}>Delete project</button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="btn ghost" onClick={() => setConfirming(true)}>Delete project…</button>
        </div>
      )}
    </SettingsSection>
  );
}

function SettingsSection(props: { title: string; state?: { tone: "ok" | "warn" | "off"; text: string } | undefined; description: ReactNode; children: ReactNode }) {
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

function ToolsCard(props: { tools: PmToolsReadResult | undefined; now: number; onRead(refresh: boolean): Promise<void> }) {
  const tools = props.tools?.tools ?? [];
  const ready = tools.filter((tool) => tool.state === "ready").length;
  const state = props.tools && { tone: ready === tools.length ? "ok" as const : "warn" as const, text: `${ready} OF ${tools.length} READY` };
  return (
    <SettingsSection title="Tools" state={state} description="What skills and agents can read through: this project's sources, the command-line tools on this machine, MCP servers, and your Claude account's connectors.">
      <ToolsChecklist tools={props.tools} now={props.now} onRead={props.onRead} />
    </SettingsSection>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return <label className="field"><span>{props.label}</span>{props.children}</label>;
}

/** The code host is never typed: the daemon reads it from the folder's git remote. */
function CodeRepositoryCard(props: SettingsPageProps) {
  const folder = props.projectFolder ?? null;
  const host = codeHost(props.sources);
  const choose = async () => {
    const picked = await props.onPickFolder?.();
    if (picked && picked !== folder) props.onSetFolder?.(picked);
  };
  const state = !folder
    ? { tone: "off" as const, text: "NOT SET" }
    : host ? { tone: "ok" as const, text: host.badge } : { tone: "warn" as const, text: "NO CODE HOST" };
  return (
    <SettingsSection
      title="Code repository"
      state={state}
      description="The local checkout of this project's code. The assistant, delivery checks and skills start in it, read-only, so they can read the code and its Git history. Its Git remote names the code host whose pull requests are matched to tickets by the issue key in their branch or title."
    >
      {folder ? (
        <dl className="repository-facts">
          <dt>Folder</dt><dd><code>{folder}</code></dd>
          <dt>Code host</dt>
          <dd>{host ? <>{host.name} · <code>{host.path}</code></> : "None found. The folder has no GitHub or Azure DevOps remote."}</dd>
        </dl>
      ) : (
        <p className="hint">Without a folder, agents start in an empty workspace of their own and tickets show no code stages.</p>
      )}
      {host && <p className="hint">Pull requests are read with {host.cli} on this computer.</p>}
      <div className="actions">
        <button type="button" className="btn pri" disabled={!props.onPickFolder} onClick={() => void choose()}>{folder ? "Change folder…" : "Choose folder…"}</button>
        {folder && <button type="button" className="btn ghost" onClick={() => props.onSetFolder?.(null)}>Remove folder</button>}
      </div>
    </SettingsSection>
  );
}

function codeHost(sources: PmSources | undefined): { badge: string; name: string; path: string; cli: string } | null {
  const github = sources?.github;
  if (github) return { badge: "GITHUB", name: "GitHub", path: `${github.owner}/${github.name}`, cli: "the GitHub CLI (gh auth login)" };
  const azure = sources?.azureDevOps;
  if (azure) return { badge: "AZURE DEVOPS", name: "Azure DevOps", path: `${azure.organization}/${azure.project}/${azure.name}`, cli: "the Azure CLI (az login, with the azure-devops extension)" };
  return null;
}

function JiraCard(props: SettingsPageProps) {
  const jira = props.sources?.jira ?? null;
  const [siteUrl, setSiteUrl] = useState(jira?.siteUrl ?? "");
  const [boardId, setBoardId] = useState(jira?.boardId?.toString() ?? "");
  const [accountEmail, setAccountEmail] = useState(jira?.accountEmail ?? "");
  // Write-only: the field starts empty and is cleared after every save.
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSiteUrl(jira?.siteUrl ?? "");
    setBoardId(jira?.boardId?.toString() ?? "");
    setAccountEmail(jira?.accountEmail ?? "");
  }, [props.sources]);

  const jiraFilled = siteUrl.trim() !== "" || accountEmail.trim() !== "";
  const save = async () => {
    setSaving(true);
    const parsedBoard = boardId.trim() === "" ? null : Number(boardId.trim());
    const jiraDraft = jiraFilled
      ? { siteUrl: siteUrl.trim().replace(/\/+$/, ""), boardId: Number.isSafeInteger(parsedBoard) ? parsedBoard : null, accountEmail: accountEmail.trim(), token }
      : null;
    try {
      await props.onSaveSources(jiraDraft);
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
        <div className="actions">
          <button type="submit" className="btn pri" disabled={saving}>Save Jira</button>
          {jira && <button type="button" className="btn ghost" onClick={props.onClearToken}>Remove stored token</button>}
        </div>
      </SettingsSection>
    </form>
  );
}

function PlaybookCard(props: { playbook: PmPlaybook | undefined; onSave(baseRevision: number, steps: PmPlaybookStep[]): Promise<boolean>; onCreate(): void }) {
  const saved = props.playbook?.steps;
  const [steps, setSteps] = useState<PmPlaybookStep[]>(saved ?? []);
  const [saving, setSaving] = useState(false);
  // Every board read is a new array; only a new revision replaces an edit in progress.
  useEffect(() => setSteps(saved ?? []), [props.playbook?.projectId, props.playbook?.revision]);
  const description = "The steps every ticket walks, in order. Facts from Jira and pull requests pass a step on their own; an agent step is checked by a small agent that reads, never changes, and says what it saw. An agent creates it from the project's repository; after that you can edit it here.";
  if (!props.playbook) return <SettingsSection title="Playbook" description={description}><p className="hint">Loading the Playbook…</p></SettingsSection>;
  const { revision } = props.playbook;
  if (revision === 0) {
    return (
      <SettingsSection title="Playbook" state={{ tone: "off", text: "NOT CREATED" }} description={description}>
        <div className="actions">
          <button type="button" className="btn pri" onClick={props.onCreate}>Create with the agent</button>
        </div>
      </SettingsSection>
    );
  }
  const agentSteps = props.playbook.steps.filter((step) => step.agent).length;
  const dirty = JSON.stringify(steps) !== JSON.stringify(saved);
  const problem = stepsProblem(steps);
  const save = async () => {
    setSaving(true);
    await props.onSave(revision, tidySteps(steps));
    setSaving(false);
  };
  return (
    <SettingsSection
      title="Playbook"
      state={{ tone: "ok", text: `${props.playbook.steps.length} STEPS · ${agentSteps} BY AN AGENT` }}
      description={description}
    >
      <PlaybookStepsEditor steps={steps} onChange={setSteps} />
      {dirty && problem && <p className="hint bad">{problem}</p>}
      <div className="actions">
        <button type="button" className="btn pri" disabled={!dirty || problem !== undefined || saving} onClick={() => void save()}>Save Playbook</button>
        {dirty && <button type="button" className="btn ghost" onClick={() => setSteps(saved ?? [])}>Undo changes</button>}
      </div>
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
  const [checkModel, setCheckModel] = useState(props.settings?.checkModel ?? "");
  const [permission, setPermission] = useState(props.settings?.assistantPermission ?? "");
  const [checkPermission, setCheckPermission] = useState(props.settings?.checkPermission ?? "");
  useEffect(() => {
    if (!props.settings) return;
    setProvider(props.settings.agentProvider);
    setModel(props.settings.agentModel);
    setCheckModel(props.settings.checkModel);
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
    setCheckModel(nextEntry?.models[0] ?? "");
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
        <Field label="Delivery check model">
          <select aria-label="Delivery check model" value={checkModel} onChange={(event) => setCheckModel(event.target.value)}>
            {choices(models, checkModel).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
        <Field label="Delivery checks">
          <select aria-label="Delivery check permission" value={checkPermission} disabled={check.length <= 1} onChange={(event) => setCheckPermission(event.target.value)}>
            {choices(check, checkPermission).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </Field>
      </div>
      <p className="hint">Choices come from the agent catalog the daemon knows. Delivery checks run on their own in the background, often, so a small model such as haiku keeps them cheap, and only modes that do not wait for an answer are offered for them.</p>
      <div className="actions">
        <button
          type="button"
          className="btn pri"
          disabled={!model || !checkModel || !permission || !checkPermission}
          onClick={() => props.onSave({ agentProvider: provider, agentModel: model, checkModel, assistantPermission: permission, checkPermission })}
        >
          Save agent settings
        </button>
      </div>
    </SettingsSection>
  );
}
