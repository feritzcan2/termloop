import { useEffect, useRef, useState } from "react";
import type { AgentCapabilityDto, LocalBranchDto, ProjectLocalBranchListResult, ProjectTaskAutomationGetResult, TaskProvisionWorktreeParams } from "@termloop/contract/current";
import type { Task } from "../../model.js";
import { agentLaunchDefaults, DEFAULT_TASK_WORKTREE_PREFIX, permissionLabel } from "../../project-task-automation.js";
import { Icon } from "../Icon.js";
import {
  selectedWorktreeParent,
  sortLocalBranches,
  suggestedBranchName,
  worktreeDestination,
  worktreePathParent,
} from "../worktree-path-suggestion.js";

export type EditorState = { mode: "create" } | { mode: "edit"; task: Task };

/// Create is not fire-and-forget: the create flow needs the new Task's identity
/// to chain the optional worktree and launches, so a success carries the id.
export type TaskCreateOutcome = { taskId: string } | { failure: string };

type TaskAgentStartSelection = {
  kind: "agent";
  agentId: string;
  model: string;
  permission: AgentCapabilityDto["permissions"][number];
  reasoning: AgentCapabilityDto["reasoning"][number];
  kickoffMessage: string | null;
};

export type TaskStartSelection = "terminal" | TaskAgentStartSelection;

function defaultAgentStart(
  capabilities: readonly AgentCapabilityDto[],
  agentId: string,
): TaskAgentStartSelection {
  const defaults = agentLaunchDefaults(capabilities, agentId);
  return {
    kind: "agent",
    agentId,
    model: defaults.model ?? "default",
    permission: defaults.permission ?? "default",
    reasoning: defaults.reasoning ?? "default",
    kickoffMessage: null,
  };
}

/// Everything the create flow needs beyond the create command itself. The flow
/// only composes the same named commands the Task row offers one by one; it adds
/// no coupling between Task and worktree.
export type CreateTaskFlow = {
  projectId: string | undefined;
  repositoryPath: string;
  rememberedParentPath: string | undefined;
  rememberParentPath(parentPath: string): void;
  listBranches(projectId: string): Promise<ProjectLocalBranchListResult>;
  loadProjectAutomation?(projectId: string): Promise<ProjectTaskAutomationGetResult>;
  agentCapabilities: readonly AgentCapabilityDto[];
  provisionWorktree(params: TaskProvisionWorktreeParams): Promise<string | undefined>;
  /// Launches wait for the worktree to become ready; the rail owns that watch,
  /// so the dialog only registers what should start.
  queueLaunches(taskId: string, starts: readonly TaskStartSelection[]): void;
};

export function TaskEditor({ state, close, createTask, updateTask, createFlow }: {
  state: EditorState;
  close(): void;
  createTask(title: string, brief: string | null): Promise<TaskCreateOutcome>;
  updateTask(taskId: string, title: string, brief: string | null): Promise<string | undefined>;
  createFlow: CreateTaskFlow;
}) {
  return state.mode === "edit"
    ? <EditTaskDialog task={state.task} close={close} updateTask={updateTask} />
    : <CreateTaskDialog close={close} createTask={createTask} flow={createFlow} />;
}

function EditTaskDialog({ task, close, updateTask }: {
  task: Task;
  close(): void;
  updateTask(taskId: string, title: string, brief: string | null): Promise<string | undefined>;
}) {
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { requestAnimationFrame(() => titleRef.current?.focus()); }, []);
  const submit = async () => {
    if (!title.trim()) { setError("Enter a Task title."); return; }
    setBusy(true); setError(undefined);
    try {
      const failure = await updateTask(task.id, title.trim(), brief.trim() || null);
      if (failure) setError(failure); else close();
    } finally { setBusy(false); }
  };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}><button className="dialog-backdrop" aria-label="Cancel editing Task" onClick={close} /><section className="dialog-card task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title"><header className="dialog-header"><div><span className="dialog-eyebrow">Task</span><h2 id="task-dialog-title">Edit Task</h2></div><button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></header><div className="dialog-body"><label htmlFor="task-title">Title</label><input ref={titleRef} id="task-title" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} /><label htmlFor="task-brief">Brief</label><textarea id="task-brief" value={brief} maxLength={8000} rows={6} onChange={(event) => setBrief(event.target.value)} placeholder="Optional context for this Task" />{error ? <p className="form-error" role="alert">{error}</p> : null}</div><footer className="dialog-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</button></footer></section></div>;
}

/// The whole first-run happy path in one dialog: name the work, accept the
/// proposed worktree (branch from the default base, sibling folder), and pick
/// what to start inside it. Branch and folder stay directly editable in the
/// plan card; nothing here is a new capability, only the existing create,
/// provision, and launch commands submitted in order.
function CreateTaskDialog({ close, createTask, flow }: {
  close(): void;
  createTask(title: string, brief: string | null): Promise<TaskCreateOutcome>;
  flow: CreateTaskFlow;
}) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [workspace, setWorkspace] = useState<"create" | "none">("create");
  const [worktreePrefix, setWorktreePrefix] = useState(DEFAULT_TASK_WORKTREE_PREFIX);
  const [starts, setStarts] = useState<ReadonlySet<string>>(new Set());
  const [agentStarts, setAgentStarts] = useState<ReadonlyMap<string, TaskAgentStartSelection>>(new Map());
  const [branchMode, setBranchMode] = useState<"existing" | "create">("create");
  const [createdBranchName, setCreatedBranchName] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [existingBranchName, setExistingBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [localBranches, setLocalBranches] = useState<readonly LocalBranchDto[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string>();
  const [branchesTruncated, setBranchesTruncated] = useState(false);
  const [destinationParentPath, setDestinationParentPath] = useState(
    () => flow.rememberedParentPath?.trim() || worktreePathParent(flow.repositoryPath),
  );
  const [editedDestinationPath, setEditedDestinationPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [createdTaskId, setCreatedTaskId] = useState<string>();
  const [automationLoading, setAutomationLoading] = useState(Boolean(flow.projectId && flow.loadProjectAutomation));
  const [automationError, setAutomationError] = useState<string>();
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { requestAnimationFrame(() => titleRef.current?.focus()); }, []);

  /// Deliberately keyed on the two stable inputs rather than the whole `flow`
  /// object, which the rail recreates per render.
  const { projectId, listBranches, loadProjectAutomation } = flow;
  useEffect(() => {
    let current = true;
    if (!projectId || !loadProjectAutomation) {
      setAutomationLoading(false);
      return () => { current = false; };
    }
    setAutomationLoading(true);
    setAutomationError(undefined);
    void loadProjectAutomation(projectId).then(({ configuration }) => {
      if (!current) return;
      setWorkspace(configuration.createWorktree ? "create" : "none");
      setWorktreePrefix(configuration.worktreePrefix);
      const selectedAgent = configuration.createWorktree
        && configuration.agentId
        && configuration.model
        && configuration.permission
        && configuration.reasoning
        && flow.agentCapabilities.some((capability) => capability.available && capability.agent_id === configuration.agentId)
        ? configuration.agentId
        : undefined;
      const selectedAgentStart: TaskAgentStartSelection | undefined = selectedAgent ? {
        kind: "agent",
        agentId: selectedAgent,
        model: configuration.model!,
        permission: configuration.permission!,
        reasoning: configuration.reasoning!,
        kickoffMessage: configuration.kickoffMessage,
      } : undefined;
      setAgentStarts(selectedAgentStart ? new Map([[selectedAgent, selectedAgentStart]]) : new Map());
      setStarts(selectedAgent ? new Set([selectedAgent]) : new Set());
      setAutomationLoading(false);
    }).catch(() => {
      if (!current) return;
      setAutomationLoading(false);
      setAutomationError("Project defaults could not be loaded. Review the visible worktree and start choices before creating the Task.");
    });
    return () => { current = false; };
  }, [loadProjectAutomation, projectId]);

  useEffect(() => {
    let current = true;
    if (!projectId) {
      setBranchesLoading(false);
      setBranchesError("Select a Project before loading local branches.");
      return () => { current = false; };
    }
    void listBranches(projectId).then((result) => {
      if (!current) return;
      const sorted = sortLocalBranches(result.branches);
      setLocalBranches(sorted);
      setBranchesTruncated(result.truncated);
      setBaseRef((selected) => sorted.some((branch) => branch.exact_ref === selected) ? selected : sorted[0]?.exact_ref ?? "");
      setExistingBranchName((selected) => sorted.some((branch) => branch.name === selected) ? selected : sorted[0]?.name ?? "");
      setBranchesLoading(false);
    }).catch((loadError: unknown) => {
      if (!current) return;
      setBranchesLoading(false);
      setBranchesError(loadError instanceof Error ? loadError.message : "Local branches could not be loaded.");
    });
    return () => { current = false; };
  }, [listBranches, projectId]);

  /// The branch field is never empty: the title drives it, and before a title
  /// exists (or when it yields no slug) a per-dialog suffix keeps the proposal
  /// concrete and collision-free without asking the user for anything.
  const [fallbackBranchSuffix] = useState(() => globalThis.crypto.randomUUID().slice(0, 4));
  /// Derived, not synchronized: the branch follows the title and the folder
  /// follows the branch until the user edits that exact field, which pins it.
  const branchName = branchMode === "existing"
    ? existingBranchName
    : branchEdited
      ? createdBranchName
      : (suggestedBranchName(title, worktreePrefix) || `${worktreePrefix}/${fallbackBranchSuffix}`);
  const destinationPath = editedDestinationPath
    ?? (branchName ? worktreeDestination(destinationParentPath, branchName) : "");
  const selectionUnavailable = branchesLoading || Boolean(branchesError) || localBranches.length === 0;

  const validateWorkspace = (): string | undefined => {
    if (!flow.repositoryPath.trim()) return "The selected Project does not have a repository path.";
    if (branchesLoading) return "Wait for local branches to load.";
    if (branchesError) return branchesError;
    if (localBranches.length === 0) return "This repository has no local branches, so a worktree cannot be created yet. Turn the worktree off to create the Task alone.";
    if (!branchName.trim()) return "Enter a branch name.";
    if (branchMode === "existing" && !localBranches.some((branch) => branch.name === branchName)) return "Select an existing local branch.";
    if (branchMode === "create" && localBranches.some((branch) => branch.name === branchName.trim())) return "A local branch with this name already exists. Pick another name or use the existing branch.";
    if (branchMode === "create" && !localBranches.some((branch) => branch.exact_ref === baseRef)) return "Select a base branch to start from.";
    if (!destinationPath.trim()) return "Enter a worktree folder.";
    return undefined;
  };

  const submit = async () => {
    if (!title.trim()) { setError("Enter a Task title."); return; }
    if (workspace === "create") {
      const invalid = validateWorkspace();
      if (invalid) { setError(invalid); return; }
    }
    setBusy(true); setError(undefined);
    try {
      let taskId = createdTaskId;
      if (!taskId) {
        const created = await createTask(title.trim(), brief.trim() || null);
        if ("failure" in created) { setError(created.failure); return; }
        taskId = created.taskId;
        setCreatedTaskId(taskId);
      }
      if (workspace === "create") {
        const parent = selectedWorktreeParent(destinationPath, branchName);
        if (parent) flow.rememberParentPath(parent);
        const failure = await flow.provisionWorktree({
          operationId: globalThis.crypto.randomUUID(),
          taskId,
          repositoryPath: flow.repositoryPath.trim(),
          destinationPath: destinationPath.trim(),
          branchName: branchName.trim(),
          branchMode,
          ...(branchMode === "create" ? { baseRef: baseRef.trim() } : {}),
        });
        if (failure) {
          setError(`${failure} The Task itself was created — adjust the values and retry, or close and add the worktree later from the Task row.`);
          return;
        }
        if (starts.size > 0) {
          const selections = [...starts].map((start): TaskStartSelection => {
            if (start === "terminal") return "terminal";
            return agentStarts.get(start) ?? defaultAgentStart(flow.agentCapabilities, start);
          });
          flow.queueLaunches(taskId, selections);
        }
      }
      close();
    } finally { setBusy(false); }
  };

  const toggleStart = (start: string) => {
    if (start !== "terminal" && !starts.has(start)) {
      setAgentStarts((current) => {
        if (current.has(start)) return current;
        const next = new Map(current);
        next.set(start, defaultAgentStart(flow.agentCapabilities, start));
        return next;
      });
    }
    setStarts((current) => {
      const next = new Set(current);
      if (next.has(start)) next.delete(start); else next.add(start);
      return next;
    });
  };
  const changeAgentStart = (
    agentId: string,
    change: Partial<Pick<TaskAgentStartSelection, "model" | "permission" | "reasoning">>,
  ) => setAgentStarts((current) => {
    const selected = current.get(agentId) ?? defaultAgentStart(flow.agentCapabilities, agentId);
    const next = new Map(current);
    next.set(agentId, { ...selected, ...change });
    return next;
  });
  const changeDestinationPath = (nextPath: string) => {
    setEditedDestinationPath(nextPath);
    const nextParent = selectedWorktreeParent(nextPath, branchName);
    if (!nextParent) return;
    setDestinationParentPath(nextParent);
    flow.rememberParentPath(nextParent);
  };
  const startOptions: readonly string[] = [
    "terminal",
    ...flow.agentCapabilities
      .filter((capability) => capability.available)
      .map((capability) => capability.agent_id),
  ];
  const startLabel = (start: string) => start === "terminal"
    ? "Terminal"
    : flow.agentCapabilities.find((capability) => capability.agent_id === start)?.label ?? start;
  const startIcon = (start: string) => start === "terminal"
    ? "terminal"
    : start === "claude" ? "claude" : start === "codex" ? "codex" : "agent";
  const selectedAgentIds = startOptions.filter((start) => start !== "terminal" && starts.has(start));
  const submitLabel = busy
    ? (createdTaskId ? "Retrying…" : "Creating…")
    : createdTaskId ? "Retry worktree"
      : workspace === "create" && starts.size > 0 ? "Create & Start"
        : "Create Task";

  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}>
    <button className="dialog-backdrop" aria-label="Cancel creating Task" onClick={close} />
    <section className="dialog-card task-dialog task-create-dialog" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title">
      <header className="dialog-header"><div><span className="dialog-eyebrow">New Task</span><h2 id="task-dialog-title">Create a Task</h2></div><button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></header>
      <div className="dialog-body">
        <label htmlFor="task-title">Title</label>
        <input ref={titleRef} id="task-title" value={title} maxLength={160} disabled={Boolean(createdTaskId)} onChange={(event) => setTitle(event.target.value)} placeholder="What is this work?" />
        <label htmlFor="task-brief">Brief</label>
        <textarea id="task-brief" value={brief} maxLength={8000} rows={3} disabled={Boolean(createdTaskId)} onChange={(event) => setBrief(event.target.value)} placeholder="Optional context for this Task" />

        {/* The worktree is one card, not a form: branch and folder as hairline
            rows of a single object, a switch to skip it, and one quiet line to
            flip between a new and an existing branch. */}
        <div className="plan-head">
          <span className="plan-heading" id="worktree-heading">Worktree</span>
          <small className="plan-sub">{workspace === "create" ? "Its own checkout of the repository" : "Off — add one later from the Task row"}</small>
          <button
            type="button"
            className={`plan-switch${workspace === "create" ? " on" : ""}`}
            role="switch"
            aria-checked={workspace === "create"}
            aria-labelledby="worktree-heading"
            disabled={automationLoading || Boolean(createdTaskId)}
            onClick={() => { setWorkspace((current) => current === "create" ? "none" : "create"); setError(undefined); }}
          ><span aria-hidden="true" /></button>
        </div>
        {workspace === "create" ? (
          <div className="plan-card">
            <div className="plan-row">
              <label className="plan-label" htmlFor={branchMode === "create" ? "create-branch-name" : "create-existing-branch"}>Branch</label>
              {branchMode === "create" ? (
                <input id="create-branch-name" value={branchName} spellCheck={false} onChange={(event) => { setBranchEdited(true); setCreatedBranchName(event.target.value); setError(undefined); }} />
              ) : (
                <select id="create-existing-branch" value={existingBranchName} disabled={selectionUnavailable} onChange={(event) => { setExistingBranchName(event.target.value); setError(undefined); }}>
                  {selectionUnavailable ? <option value="">{branchesLoading ? "Loading local branches…" : "No local branches"}</option> : null}
                  {localBranches.map((branch) => <option key={branch.exact_ref} value={branch.name}>{branch.name}</option>)}
                </select>
              )}
            </div>
            {branchMode === "create" ? (
              <div className="plan-row">
                <label className="plan-label" htmlFor="create-base-ref">Base branch</label>
                <select id="create-base-ref" value={baseRef} disabled={selectionUnavailable} onChange={(event) => { setBaseRef(event.target.value); setError(undefined); }}>
                  {selectionUnavailable ? <option value="">{branchesLoading ? "Loading local branches…" : "No local branches"}</option> : null}
                  {localBranches.map((branch) => <option key={branch.exact_ref} value={branch.exact_ref}>{branch.name}</option>)}
                </select>
              </div>
            ) : null}
            <div className="plan-row">
              <label className="plan-label" htmlFor="create-destination-path">Folder</label>
              <input id="create-destination-path" value={destinationPath} spellCheck={false} title="Created new — TermLoop never adopts or overwrites an existing folder." onChange={(event) => changeDestinationPath(event.target.value)} />
            </div>
            <button type="button" className="plan-alt" onClick={() => { setBranchMode((mode) => mode === "create" ? "existing" : "create"); setError(undefined); }}>
              {branchMode === "create" ? "Use an existing branch instead" : "Create a new branch instead"}
            </button>
          </div>
        ) : null}
        {workspace === "create" && branchesTruncated ? <p className="field-help" role="status">Only the first 512 local branches are shown.</p> : null}

        <div className="plan-head">
          <span className="plan-heading">Start</span>
          <small className="plan-sub">{workspace === "create" ? "Launches when the worktree is ready" : "Needs a worktree"}</small>
        </div>
        <div className="start-chips" role="group" aria-label="Start when the worktree is ready">
          {startOptions.map((start) => (
            <button
              key={start}
              type="button"
              className={`start-chip${starts.has(start) ? " on" : ""}`}
              aria-pressed={starts.has(start)}
              disabled={automationLoading || workspace !== "create"}
              onClick={() => toggleStart(start)}
            >
              <Icon name={startIcon(start)} />
              <span>{startLabel(start)}</span>
            </button>
          ))}
        </div>
        {workspace === "create" && selectedAgentIds.length > 0 ? (
          <div className="start-agent-configurations" aria-label="Agent launch settings">
            {selectedAgentIds.map((agentId) => {
              const capability = flow.agentCapabilities.find((candidate) => candidate.agent_id === agentId)!;
              const selection = agentStarts.get(agentId) ?? defaultAgentStart(flow.agentCapabilities, agentId);
              const label = startLabel(agentId);
              return <section className="start-agent-configuration" key={agentId} aria-label={`${label} launch settings`}>
                <div className="start-agent-configuration-head"><Icon name={startIcon(agentId)} /><span>{label}</span></div>
                <div className="task-automation-launch-options">
                  <label htmlFor={`create-agent-${agentId}-model`}><span>Model</span>
                    <select id={`create-agent-${agentId}-model`} aria-label={`${label} model`} value={selection.model} disabled={busy || automationLoading} onChange={(event) => changeAgentStart(agentId, { model: event.target.value })}>
                      {capability.models.map((model) => <option key={model} value={model}>{model}</option>)}
                    </select>
                  </label>
                  <label htmlFor={`create-agent-${agentId}-permission`}><span>Permission mode</span>
                    <select id={`create-agent-${agentId}-permission`} aria-label={`${label} permission mode`} value={selection.permission} disabled={busy || automationLoading} onChange={(event) => changeAgentStart(agentId, { permission: event.target.value as TaskAgentStartSelection["permission"] })}>
                      {capability.permissions.map((permission) => <option key={permission} value={permission}>{permissionLabel(permission)}</option>)}
                    </select>
                  </label>
                  <label htmlFor={`create-agent-${agentId}-reasoning`}><span>Reasoning</span>
                    <select id={`create-agent-${agentId}-reasoning`} aria-label={`${label} reasoning`} value={selection.reasoning} disabled={busy || automationLoading} onChange={(event) => changeAgentStart(agentId, { reasoning: event.target.value as TaskAgentStartSelection["reasoning"] })}>
                      {capability.reasoning.map((reasoning) => <option key={reasoning} value={reasoning}>{reasoning}</option>)}
                    </select>
                  </label>
                </div>
              </section>;
            })}
          </div>
        ) : null}

        {automationLoading ? <p className="field-help" role="status">Loading Project defaults…</p> : null}
        {automationError ? <p className="field-help" role="status">{automationError}</p> : null}
        {branchesError && workspace === "create" ? <p className="form-error" role="alert">{branchesError}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={busy || automationLoading || !title.trim()} onClick={() => void submit()}>{submitLabel}</button></footer>
    </section>
  </div>;
}
