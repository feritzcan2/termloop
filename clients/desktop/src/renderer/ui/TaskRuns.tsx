import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RunConfigurationCreateParams,
  RunConfigurationDto,
  RunConfigurationImproverTarget,
  RunConfigurationKind,
  RunConfigurationUpdateParams,
  RunSetupPolicy,
  ConfigurationVersionDto,
  ConfigurationVersionListResult,
  ConfigurationVersionMutationResult,
  VersionedConfigurationTarget,
} from "@termloop/contract/current";
import type { RunConfiguration, RunRuntime, Session, Task } from "../model.js";
import { isLiveSession } from "../model.js";
import type { QuickActionAgentSelection } from "../quick-action-memory.js";
import { Icon } from "./Icon.js";
import { OverlayPortal } from "./OverlayPortal.js";
import { ConfigurationVersions, type ConfigurationVersionsController } from "./PromptImprovement.js";

/// A run configuration is a launcher until it runs, and once it runs it *is*
/// the Terminal Session core named after it. So the rail never draws a second
/// card for a live run: idle configurations sit in the Task's Start row beside
/// the terminal and agent launchers, and a running one is represented by its
/// own Session row plus `RunSessionLine` for the facts a Session row cannot
/// carry — detected URLs, restart, and a failing exit code.
export function TaskRunLaunchers(props: {
  projectId: string;
  task: Task;
  configurations: readonly RunConfiguration[];
  runtimes: readonly RunRuntime[];
  sessionsById: ReadonlyMap<string, Session>;
  stateRevision: number;
  launchable: boolean;
  overlayContainer: Element | undefined;
  overlayVisibilityChanged(visible: boolean): void;
  improvement?: RunImprovement | undefined;
  setupImprovement(projectId: string, target: RunConfigurationImproverTarget): void;
  save(params: RunConfigurationCreateParams | RunConfigurationUpdateParams): Promise<RunConfigurationDto | string>;
  remove(configurationId: string): Promise<string | undefined>;
  launch(taskId: string, configurationId: string, restart: boolean, forceSetup?: boolean): Promise<string | undefined>;
}) {
  const [editing, setEditing] = useState<RunConfigurationDto | "new">();
  const [busyId, setBusyId] = useState<string>();
  const { task, runtimes, sessionsById } = props;
  /// Hidden only when this Task's run really is on screen as a live Session
  /// row. A run whose Session dropped out of the projection keeps its chip, so
  /// the launcher can never become the only missing handle.
  const liveConfigurationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const runtime of runtimes) {
      if (runtime.taskId !== task.id) continue;
      const session = sessionsById.get(runtime.sessionId);
      if (session && isLiveSession(session)) ids.add(runtime.configurationId);
    }
    return ids;
  }, [runtimes, sessionsById, task.id]);
  const idle = props.configurations.filter((configuration) => !liveConfigurationIds.has(configuration.id));

  const { overlayVisibilityChanged } = props;
  useEffect(() => {
    overlayVisibilityChanged(Boolean(editing));
    return () => overlayVisibilityChanged(false);
  }, [editing, overlayVisibilityChanged]);

  const start = async (configuration: RunConfiguration, forceSetup: boolean) => {
    setBusyId(configuration.id);
    await props.launch(task.id, configuration.id, false, forceSetup);
    setBusyId(undefined);
  };

  return <>
    {idle.length > 0 ? <span className="task-launch-divider" aria-hidden="true" /> : null}
    {idle.map((configuration) => {
      const setupOnDemand = Boolean(configuration.setupCommand) && configuration.setupPolicy !== "never";
      return <span className="run-chip" key={configuration.id}>
        <button
          type="button"
          className="run-chip-start"
          disabled={!props.launchable || busyId === configuration.id}
          title={`${runKindLabel(configuration.kind)} · ${configuration.command}${setupOnDemand ? "\nHold Option to run setup again first." : ""}`}
          aria-label={`Run ${configuration.name} in ${task.title}`}
          onClick={(event) => void start(configuration, setupOnDemand && event.altKey)}
          onContextMenu={(event) => { event.preventDefault(); setEditing(configuration); }}
        ><Icon name="play" />{configuration.name}</button>
        <button
          type="button"
          className="run-chip-edit"
          title={`Edit ${configuration.name}`}
          aria-label={`Edit run configuration ${configuration.name}`}
          onClick={() => setEditing(configuration)}
        ><Icon name="edit" /></button>
      </span>;
    })}
    {/* No bare "+" here: every chip in this row is already a run button, and
        adding or editing a configuration belongs to the chip's own pencil and
        to the Project launcher bar above. */}
    <OverlayPortal container={props.overlayContainer}>
      {editing ? <RunEditorDialog
        projectId={props.projectId}
        {...(editing === "new" ? {} : { configuration: editing })}
        {...(props.improvement ? { improvement: props.improvement } : {})}
        setupImprovement={props.setupImprovement}
        stateRevision={props.stateRevision}
        canRun={props.launchable}
        close={() => setEditing(undefined)}
        save={props.save}
        remove={props.remove}
        run={(configurationId) => props.launch(task.id, configurationId, false)}
      /> : null}
    </OverlayPortal>
  </>;
}

/// The one line a run Session needs beyond its row: where to open it, how to
/// restart it, and why it stopped. Silent for every Session that is not a run,
/// and for a run that exited cleanly — its row already states that.
export function RunSessionLine(props: {
  session: Session;
  runtime: RunRuntime;
  restart(): Promise<string | undefined>;
  stop(): void;
  openExternal(url: string, runSessionId?: string): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const live = isLiveSession(props.session);
  const failed = !live && props.runtime.exitCode !== null && props.runtime.exitCode !== 0;
  if (!live && !failed) return null;
  return <div className="run-line">
    {live ? props.runtime.urls.map((url) => (
      <button
        type="button"
        className="run-url"
        key={url}
        title={`Open ${url} in the browser`}
        onClick={() => void props.openExternal(url, props.runtime.sessionId)}
      ><Icon name="external" />{displayUrl(url)}</button>
    )) : null}
    {/* Restart and stop are one control for one process, not two loose glyphs
        hanging off the row. Stop ends the process and removes the Session, the
        same thing the row's own close does. */}
    {live ? <span className="run-controls">
      <button
        type="button"
        className="run-control"
        disabled={busy}
        title="Restart this run"
        aria-label="Restart this run"
        onClick={async () => { setBusy(true); await props.restart(); setBusy(false); }}
      ><Icon name="restart" /></button>
      <button
        type="button"
        className="run-control stop"
        disabled={busy}
        title="Stop this run"
        aria-label="Stop this run"
        onClick={props.stop}
      ><Icon name="stop" /></button>
    </span> : null}
    {failed ? <span className="run-line-exit">exit {props.runtime.exitCode}</span> : null}
  </div>;
}

/// Runs are keyed by Session so any Session row — inside a Task group or in the
/// Project list — can find its own runtime without re-deriving containment.
export function runtimesBySessionId(runtimes: readonly RunRuntime[]): ReadonlyMap<string, RunRuntime> {
  return new Map(runtimes.map((runtime) => [runtime.sessionId, runtime]));
}

/// The command a run row describes itself with. Taken from the configuration
/// rather than the Session's argv, which carries the shell wrapper and, after a
/// setup launch, the chained setup command as well.
export function runCommandsBySessionId(
  runtimes: readonly RunRuntime[],
  configurations: readonly RunConfiguration[],
): ReadonlyMap<string, string> {
  const commands = new Map(configurations.map((configuration) => [configuration.id, configuration.command]));
  return new Map(runtimes.flatMap((runtime) => {
    const command = commands.get(runtime.configurationId);
    return command ? [[runtime.sessionId, command] as const] : [];
  }));
}

const kindLabels: Record<RunConfigurationKind, string> = {
  devServer: "Dev server",
  build: "Build",
  testRunner: "Tests",
  typecheck: "Type check",
  storybook: "Storybook",
  custom: "Custom",
};

const setupPolicyLabels: Record<RunSetupPolicy, string> = {
  oncePerWorktree: "Once per worktree",
  always: "Before every run",
  never: "Never",
};

export function runKindLabel(kind: RunConfigurationKind): string {
  return kindLabels[kind] ?? kind;
}

/// `http://localhost:5173/` is 22 characters of which 8 carry meaning in a
/// 240px rail. The full URL stays in the title and in what actually opens.
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/// The dev server offer arrives already describing a dev server, so the first
/// run a Project ever configures asks only for its command.
export const DEV_SERVER_SEED: RunConfigurationSeed = { name: "Dev server", kind: "devServer" };

export type RunConfigurationSeed = { name: string; kind: RunConfigurationKind };

type Draft = {
  name: string;
  kind: RunConfigurationKind;
  command: string;
  workingDirectory: string;
  env: string;
  setupCommand: string;
  setupPolicy: RunSetupPolicy;
  urlAutoDetect: boolean;
  fallbackUrls: string;
  autoOpenFirstUrl: boolean;
};

export type RunImprovement = {
  start(projectId: string, target: RunConfigurationImproverTarget, selection?: QuickActionAgentSelection, options?: { fresh?: boolean }): Promise<string | undefined>;
  versions(projectId: string, target: VersionedConfigurationTarget): Promise<ConfigurationVersionListResult | string>;
  restore(projectId: string, target: VersionedConfigurationTarget, versionId: string, expectedActiveVersionId: string | null): Promise<ConfigurationVersionMutationResult | string>;
};

/// Name, command, kind are the run. Everything else is a property of one of two
/// concrete objects — the setup that precedes it, and the URLs it serves — so
/// they render as the Task dialog's plan cards instead of a wall of fields.
export function RunEditorDialog(props: {
  projectId: string;
  configuration?: RunConfigurationDto;
  seed?: RunConfigurationSeed | undefined;
  stateRevision: number;
  canRun: boolean;
  improvement?: RunImprovement | undefined;
  setupImprovement(projectId: string, target: RunConfigurationImproverTarget): void;
  close(): void;
  save(params: RunConfigurationCreateParams | RunConfigurationUpdateParams): Promise<RunConfigurationDto | string>;
  remove(configurationId: string): Promise<string | undefined>;
  run(configurationId: string): Promise<string | undefined>;
}) {
  const [draft, setDraft] = useState<Draft>(() => configurationDraft(props.configuration, props.seed));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const commandRef = useRef<HTMLTextAreaElement>(null);
  /// A seeded run is already named, so the only thing left to answer is the
  /// command — put the caret there instead of on a field that is done.
  const seeded = !props.configuration && Boolean(props.seed);
  useEffect(() => {
    requestAnimationFrame(() => (seeded ? commandRef.current : nameRef.current)?.focus());
  }, [seeded]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setConfirmingDelete(false);
  };

  /// An improver targets the configuration being edited, or — in first setup —
  /// the kind this Project does not have yet. Only a configuration whose kind
  /// is known can be improved: an unseeded blank "Add a run" has nothing for an
  /// agent to go looking for.
  const { improvement, configuration, seed } = props;
  const target: RunConfigurationImproverTarget | undefined = configuration
    ? { configurationId: configuration.id, newKind: null }
    : seed ? { configurationId: null, newKind: seed.kind } : undefined;
  const creating = Boolean(target && !configuration);
  const versionTarget = useMemo<VersionedConfigurationTarget | undefined>(() => target
    ? target.configurationId
      ? { kind: "runConfiguration", targetId: target.configurationId }
      : { kind: "newRunConfiguration", targetId: target.newKind }
    : undefined, [target?.configurationId, target?.newKind]);
  const [history, setHistory] = useState<ConfigurationVersionListResult>();
  const [versionBusy, setVersionBusy] = useState(false);
  const refreshVersions = useCallback(async () => {
    if (!improvement || !versionTarget) return;
    const result = await improvement.versions(props.projectId, versionTarget);
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setHistory(result);
  }, [improvement, props.projectId, versionTarget]);
  useEffect(() => { void refreshVersions(); }, [refreshVersions]);
  useEffect(() => {
    const onFocus = () => void refreshVersions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshVersions]);
  const useActivatedSnapshot = (result: ConfigurationVersionMutationResult) => {
    if (creating) {
      props.close();
      return;
    }
    try {
      setDraft(configurationDraft(JSON.parse(result.activeVersion.content) as RunConfigurationDto));
    } catch {
      setError("The active run version could not be displayed.");
    }
  };
  const versionController = useMemo<ConfigurationVersionsController>(() => ({
    history,
    busy: versionBusy,
    error,
    restore: async (version: ConfigurationVersionDto, restored: () => void | Promise<void>) => {
      if (!improvement || !versionTarget) return undefined;
      setVersionBusy(true);
      try {
        const result = await improvement.restore(
          props.projectId,
          versionTarget,
          version.id,
          history?.activeVersionId ?? null,
        );
        if (typeof result === "string") { setError(result); return result; }
        useActivatedSnapshot(result);
        await refreshVersions();
        await restored();
        return undefined;
      } finally { setVersionBusy(false); }
    },
  }), [creating, error, history, improvement, props.projectId, refreshVersions, versionBusy, versionTarget]);

  const startImprover = async () => {
    if (!improvement || !target) return;
    setBusy(true); setError(undefined);
    try {
      const failure = await improvement.start(props.projectId, target);
      if (failure) { setError(failure); return; }
      props.close();
    } finally { setBusy(false); }
  };

  const setupImprover = () => {
    if (!target) return;
    props.setupImprovement(props.projectId, target);
    props.close();
  };

  const submit = async (runAfterSave: boolean) => {
    const env = parseEnvironment(draft.env);
    if (typeof env === "string") { setError(env); return; }
    const name = draft.name.trim();
    if (!name || !draft.command.trim()) { setError("Enter a name and the command to run."); return; }
    setBusy(true); setError(undefined);
    try {
      const shared = {
        name,
        kind: draft.kind,
        command: draft.command,
        workingDirectory: draft.workingDirectory.trim() || ".",
        env,
        setupCommand: draft.setupCommand.trim() || null,
        setupPolicy: draft.setupPolicy,
        urlAutoDetect: draft.urlAutoDetect,
        fallbackUrls: draft.fallbackUrls.split(/[\n,]/).map((url) => url.trim()).filter(Boolean),
        autoOpenFirstUrl: draft.autoOpenFirstUrl,
        expectedRevision: props.stateRevision,
      };
      const result = await props.save(props.configuration
        ? { ...shared, configurationId: props.configuration.id }
        : { ...shared, projectId: props.projectId });
      if (typeof result === "string") { setError(result); return; }
      if (runAfterSave) {
        const failure = await props.run(result.id);
        if (failure) { setError(failure); return; }
      }
      props.close();
    } finally { setBusy(false); }
  };

  const deleteConfiguration = async () => {
    if (!props.configuration) return;
    if (!confirmingDelete) { setConfirmingDelete(true); return; }
    setBusy(true); setError(undefined);
    try {
      const failure = await props.remove(props.configuration.id);
      if (failure) { setError(failure); setConfirmingDelete(false); return; }
      props.close();
    } finally { setBusy(false); }
  };

  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && props.close()}>
    <button className="dialog-backdrop" aria-label="Close run configuration" onClick={props.close} />
    <section className="dialog-card run-dialog" role="dialog" aria-modal="true" aria-labelledby="run-dialog-title">
      <header className="dialog-header">
        <div className="run-dialog-heading">
          {/* The kind decides what an improver goes looking for, so it reads as
              a tag beside the eyebrow instead of hiding in the advanced
              fieldset — except when the name already says it. It tracks the
              draft, so changing Kind down there is visible up here. */}
          <span className="run-dialog-eyebrow">
            <span className="dialog-eyebrow">{props.configuration ? "Run" : "New run"}</span>
            {runKindLabel(draft.kind).toLowerCase() === draft.name.trim().toLowerCase()
              ? null
              : <span className="run-kind-tag">{runKindLabel(draft.kind)}</span>}
          </span>
          <h2 id="run-dialog-title">{props.configuration
            ? props.configuration.name
            : props.seed ? `Set up the ${props.seed.name.toLowerCase()}` : "Add a run"}</h2>
        </div>
        <button className="icon-button quiet" aria-label="Close dialog" onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">
        <ConfigurationVersions controller={versionController} reload={() => undefined} />
        {/* The Agent can inspect the checkout and test the command. Once the
            user says “apply”, the Agent creates and activates a new version. */}
        {configuration && improvement ? <section className="run-improve-bar">
          <span className="run-improve-bar-glyph" aria-hidden="true"><Icon name="sparkles" /></span>
          <div className="run-improve-bar-text">
            <strong>Let an agent fix this run</strong>
            <small>It tests the command; saying “apply” activates a new immutable version.</small>
          </div>
          <span className="run-improve agent-action-split">
            <button
              type="button"
              className="primary-button agent-action-main"
              disabled={busy}
              title="Start an agent that inspects this checkout and tests a corrected configuration"
              onClick={() => void startImprover()}
            ><Icon name="sparkles" />Improve with agent</button>
            <button
              type="button"
              className="primary-button agent-action-setup"
              disabled={busy}
              title="Choose the agent and fallback launch settings"
              onClick={setupImprover}
            >Setup <span aria-hidden="true">▾</span></button>
          </span>
        </section> : null}
        {/* First setup leads with the agent: at this point the user usually
            knows what they want running but not the exact command, and the
            agent can read the repo and try it. The manual fields stay right
            below for anyone who already knows. */}
        {creating && improvement ? <section className="run-improve-offer">
          <h3><Icon name="sparkles" />Let an agent set this up</h3>
          <p>It reads this project and tests the command it finds. Saying “apply” creates the run as the latest immutable version.</p>
          <div className="run-improve-buttons agent-action-split">
            <button
              type="button"
              className="primary-button agent-action-main"
              disabled={busy}
              onClick={() => void startImprover()}
            ><Icon name="sparkles" />Improve with agent</button>
            <button type="button" className="primary-button agent-action-setup" disabled={busy} onClick={setupImprover}>Setup <span aria-hidden="true">▾</span></button>
          </div>
          <span className="run-improve-or">or describe it yourself</span>
        </section> : null}
        <label htmlFor="run-name">Name</label>
        <input
          ref={nameRef}
          id="run-name"
          value={draft.name}
          maxLength={80}
          placeholder="Dev server"
          onChange={(event) => set("name", event.target.value)}
        />
        <label htmlFor="run-command">Command</label>
        <textarea
          ref={commandRef}
          id="run-command"
          className="run-command"
          value={draft.command}
          rows={2}
          spellCheck={false}
          placeholder="pnpm dev"
          onChange={(event) => set("command", event.target.value)}
        />
        <p className="field-help">Runs in this Task&rsquo;s checkout through the shell, as a Terminal Session you can read and type into.</p>

        <div className="plan-head">
          <span className="plan-heading">Setup</span>
          <small className="plan-sub">Prepares the checkout before the command</small>
        </div>
        <div className="plan-card">
          <div className="plan-row">
            <label className="plan-label" htmlFor="run-setup-command">Command</label>
            <input
              id="run-setup-command"
              value={draft.setupCommand}
              spellCheck={false}
              placeholder="pnpm install"
              onChange={(event) => set("setupCommand", event.target.value)}
            />
          </div>
          {draft.setupCommand.trim() ? (
            <div className="plan-row">
              <label className="plan-label" htmlFor="run-setup-policy">When</label>
              <select id="run-setup-policy" value={draft.setupPolicy} onChange={(event) => set("setupPolicy", event.target.value as RunSetupPolicy)}>
                {(Object.keys(setupPolicyLabels) as RunSetupPolicy[]).map((policy) => (
                  <option key={policy} value={policy}>{setupPolicyLabels[policy]}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div className="plan-head">
          <span className="plan-heading">URLs</span>
          <small className="plan-sub">{draft.urlAutoDetect ? "Read from the run’s own output" : "Only the addresses listed here"}</small>
          <button
            type="button"
            className={`plan-switch${draft.urlAutoDetect ? " on" : ""}`}
            role="switch"
            aria-checked={draft.urlAutoDetect}
            aria-label="Detect localhost URLs from output"
            onClick={() => set("urlAutoDetect", !draft.urlAutoDetect)}
          ><span aria-hidden="true" /></button>
        </div>
        <div className="plan-card">
          <div className="plan-row">
            <label className="plan-label" htmlFor="run-fallback-urls">Fallback</label>
            <input
              id="run-fallback-urls"
              value={draft.fallbackUrls}
              spellCheck={false}
              placeholder="http://localhost:5173"
              onChange={(event) => set("fallbackUrls", event.target.value)}
            />
          </div>
          <div className="plan-row">
            <span className="plan-label" id="run-auto-open-label">On start</span>
            <div className="plan-inline">
              <button
                type="button"
                className={`plan-switch${draft.autoOpenFirstUrl ? " on" : ""}`}
                role="switch"
                aria-checked={draft.autoOpenFirstUrl}
                aria-labelledby="run-auto-open-label"
                onClick={() => set("autoOpenFirstUrl", !draft.autoOpenFirstUrl)}
              ><span aria-hidden="true" /></button>
              <small>Open the first URL in the browser</small>
            </div>
          </div>
        </div>

        <details className="run-advanced">
          <summary>Kind, folder, and environment</summary>
          <label htmlFor="run-kind">Kind</label>
          <select id="run-kind" value={draft.kind} onChange={(event) => set("kind", event.target.value as RunConfigurationKind)}>
            {(Object.keys(kindLabels) as RunConfigurationKind[]).map((kind) => (
              <option key={kind} value={kind}>{kindLabels[kind]}</option>
            ))}
          </select>
          <label htmlFor="run-working-directory">Folder</label>
          <input
            id="run-working-directory"
            value={draft.workingDirectory}
            spellCheck={false}
            placeholder="."
            onChange={(event) => set("workingDirectory", event.target.value)}
          />
          <p className="field-help">Relative to the checkout. <code>.</code> is its root.</p>
          <label htmlFor="run-env">Environment</label>
          <textarea
            id="run-env"
            className="run-command"
            value={draft.env}
            rows={3}
            spellCheck={false}
            placeholder={"PORT=5173\nNODE_ENV=development"}
            onChange={(event) => set("env", event.target.value)}
          />
          <p className="field-help">One <code>KEY=value</code> per line.</p>
        </details>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions">
        {props.configuration ? (
          <button
            className={confirmingDelete ? "danger-button run-delete" : "secondary-button run-delete"}
            disabled={busy}
            onClick={() => void deleteConfiguration()}
          >{confirmingDelete ? "Delete for good" : "Delete"}</button>
        ) : null}
        <button className="secondary-button" onClick={props.close}>Cancel</button>
        <button className="secondary-button" disabled={busy} onClick={() => void submit(false)}>{busy ? "Saving…" : "Save"}</button>
        {props.canRun ? <button className="primary-button" disabled={busy} onClick={() => void submit(true)}>Save &amp; run</button> : null}
      </footer>
    </section>
  </div>;
}

function configurationDraft(configuration?: RunConfigurationDto, seed?: RunConfigurationSeed): Draft {
  return {
    name: configuration?.name ?? seed?.name ?? "",
    kind: configuration?.kind ?? seed?.kind ?? "custom",
    command: configuration?.command ?? "",
    workingDirectory: configuration?.workingDirectory ?? ".",
    env: configuration?.env.map((entry) => `${entry.name}=${entry.value}`).join("\n") ?? "",
    setupCommand: configuration?.setupCommand ?? "",
    setupPolicy: configuration?.setupPolicy ?? "oncePerWorktree",
    urlAutoDetect: configuration?.urlAutoDetect ?? true,
    fallbackUrls: configuration?.fallbackUrls.join(", ") ?? "",
    autoOpenFirstUrl: configuration?.autoOpenFirstUrl ?? false,
  };
}

function parseEnvironment(source: string): { name: string; value: string }[] | string {
  const entries: { name: string; value: string }[] = [];
  for (const line of source.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const separator = line.indexOf("=");
    const name = separator >= 0 ? line.slice(0, separator).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `Invalid environment entry: ${line}`;
    if (entries.some((entry) => entry.name === name)) return `Duplicate environment variable: ${name}`;
    entries.push({ name, value: line.slice(separator + 1) });
  }
  return entries;
}
