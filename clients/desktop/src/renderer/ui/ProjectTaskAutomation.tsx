import type {
  AgentCapabilityDto,
  ProjectTaskAutomationGetResult,
  ProjectTaskAutomationSetParams,
  ProjectTaskAutomationSetResult,
  RemoteBranchDto,
  WorkflowConfigurationDto,
} from "@termloop/contract/current";
import {
  agentLaunchDefaults,
  agentChoiceOptions,
  DEFAULT_TASK_KICKOFF_MESSAGE,
  permissionLabel,
  type ProjectTaskAutomationDraft,
} from "../project-task-automation.js";
import { workflowSummary, workflowLaunchSummary } from "./workflow-presentation.js";

export type ProjectTaskAutomationActions = {
  getProjectAutomation(projectId: string): Promise<ProjectTaskAutomationGetResult>;
  setProjectAutomation(params: ProjectTaskAutomationSetParams): Promise<ProjectTaskAutomationSetResult>;
};

/// Create worktree / start agent, the two facts a new Task carries. The same
/// control renders the Project default and an explicit one-shot import choice,
/// keeping both surfaces aligned without making a provider own the default.
export function WorktreeAgentChoice({ idPrefix, value, busy, agentCapabilities, workflows = [], baseBranches, branchesLoading, branchesError, worktreeHint, agentHint, change }: {
  idPrefix: string;
  value: ProjectTaskAutomationDraft;
  busy: boolean;
  agentCapabilities: readonly AgentCapabilityDto[];
  workflows?: readonly WorkflowConfigurationDto[];
  baseBranches: readonly RemoteBranchDto[];
  branchesLoading: boolean;
  branchesError: string | undefined;
  worktreeHint: string;
  agentHint: string;
  change(next: ProjectTaskAutomationDraft): void;
}) {
  const options = agentChoiceOptions(agentCapabilities, value.agentId);
  const startAgent = value.agentId !== null;
  const startWorkflow = value.workflowId != null;
  const selectedWorkflow = workflows.find((workflow) => workflow.id === value.workflowId);
  const noAgentAvailable = options.every((option) => !option.available);
  const selectedCapability = value.agentId === null
    ? undefined
    : agentCapabilities.find((capability) => capability.agent_id === value.agentId);
  const modelOptions = selectedCapability?.models ?? (value.model ? [value.model] : []);
  const permissionOptions = selectedCapability?.permissions ?? (value.permission ? [value.permission] : []);
  const reasoningOptions = selectedCapability?.reasoning ?? (value.reasoning ? [value.reasoning] : []);
  return <div className="task-automation-choices">
    <label className="checkbox-row">
      <input
        id={`${idPrefix}-worktree`}
        type="checkbox"
        checked={value.createWorktree}
        disabled={busy || startAgent || startWorkflow}
        onChange={(event) => change(event.target.checked
          ? { ...value, createWorktree: true }
          : { createWorktree: false, worktreePrefix: value.worktreePrefix, baseRef: value.baseRef, workflowId: null, agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null })}
      />
      <span><strong>Create worktree</strong><small>{worktreeHint}</small></span>
    </label>
    <label className="checkbox-row">
      <input
        id={`${idPrefix}-start-agent`}
        type="checkbox"
        checked={startAgent}
        disabled={busy || (!startAgent && noAgentAvailable)}
        onChange={(event) => {
          const agentId = options.find((option) => option.available)?.agentId ?? null;
          change(event.target.checked && agentId
            ? { ...value, createWorktree: true, workflowId: null, agentId, ...agentLaunchDefaults(agentCapabilities, agentId), kickoffMessage: null }
            : { ...value, agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null });
        }}
      />
      <span><strong>Start agent</strong><small>{!startAgent && noAgentAvailable ? "No configured agent is currently available." : agentHint}</small></span>
    </label>
    <label className="checkbox-row">
      <input id={`${idPrefix}-start-workflow`} type="checkbox" checked={startWorkflow} disabled={busy || (!startWorkflow && workflows.length === 0)} onChange={(event) => change(event.target.checked
        ? { ...value, createWorktree: true, workflowId: workflows[0]!.id, agentId: null, model: null, permission: null, reasoning: null, kickoffMessage: null }
        : { ...value, workflowId: null })} />
      <span><strong>Start workflow</strong><small>{workflows.length ? "Run a saved multi-agent workflow after the worktree is ready. Replaces the single-agent choice." : "No workflow templates yet. Create one from a Task’s Workflow menu."}</small></span>
    </label>
    {startWorkflow ? <>
      <label htmlFor={`${idPrefix}-workflow`}>Workflow template</label>
      <select id={`${idPrefix}-workflow`} value={value.workflowId ?? ""} disabled={busy} onChange={(event) => change({ ...value, workflowId: event.target.value })}>
        {!selectedWorkflow ? <option value={value.workflowId ?? ""}>Selected template (unavailable)</option> : null}
        {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
      </select>
      {selectedWorkflow ? <><p className="field-help">{workflowSummary(selectedWorkflow)}</p><p className="field-help">{selectedWorkflow.coordinatorAgentId} lead · {workflowLaunchSummary(selectedWorkflow)}</p></> : <p className="form-error" role="alert">Choose an available template. No agent will be substituted.</p>}
      <p className="field-help">The Task description becomes the goal; its title is used when the description is empty. Agent, model, permissions, and review steps come from the template when the workflow starts.</p>
    </> : null}
    {value.createWorktree ? <>
      <label htmlFor={`${idPrefix}-base-ref`}>Base branch</label>
      <select
        id={`${idPrefix}-base-ref`}
        value={value.baseRef ?? ""}
        disabled={busy || branchesLoading || Boolean(branchesError) || baseBranches.length === 0}
        onChange={(event) => change({ ...value, baseRef: event.target.value })}
      >
        {value.baseRef && !baseBranches.some((branch) => branch.exact_ref === value.baseRef)
          ? <option value={value.baseRef}>{value.baseRef.replace(/^refs\/remotes\//, "")} (unavailable)</option>
          : null}
        {!value.baseRef ? <option value="">{branchesLoading ? "Loading remote branches…" : "Choose a remote branch…"}</option> : null}
        {baseBranches.map((branch) => <option key={branch.exact_ref} value={branch.exact_ref}>{branch.name}</option>)}
      </select>
      {branchesError ? <p className="form-error" role="alert">{branchesError}</p> : null}
      {!branchesLoading && !branchesError && baseBranches.length === 0 ? <p className="field-help">No remote-tracking branches are available. Fetch the repository first.</p> : null}
      <label htmlFor={`${idPrefix}-worktree-prefix`}>Branch/worktree prefix</label>
      <input
        id={`${idPrefix}-worktree-prefix`}
        value={value.worktreePrefix}
        disabled={busy}
        maxLength={32}
        spellCheck={false}
        onChange={(event) => change({ ...value, worktreePrefix: event.target.value })}
      />
      <p className="field-help">Branches start with <code>{value.worktreePrefix || "prefix"}/</code>; sibling worktree folders start with <code>{value.worktreePrefix || "prefix"}-</code>.</p>
    </> : null}
    {startAgent ? <>
      <label htmlFor={`${idPrefix}-agent`}>Agent</label>
      <select id={`${idPrefix}-agent`} value={value.agentId ?? ""} disabled={busy} onChange={(event) => change({
        ...value,
        createWorktree: true,
        agentId: event.target.value,
        ...agentLaunchDefaults(agentCapabilities, event.target.value),
      })}>
        {options.map((option) => <option key={option.agentId} value={option.agentId}>{option.label}{option.available ? "" : " (currently unavailable)"}</option>)}
      </select>
      <div className="task-automation-launch-options">
        <label htmlFor={`${idPrefix}-model`}><span>Model</span>
          <select id={`${idPrefix}-model`} value={value.model ?? ""} disabled={busy} onChange={(event) => change({ ...value, model: event.target.value })}>
            {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-permission`}><span>Permission mode</span>
          <select id={`${idPrefix}-permission`} value={value.permission ?? ""} disabled={busy} onChange={(event) => change({ ...value, permission: event.target.value as ProjectTaskAutomationDraft["permission"] })}>
            {permissionOptions.map((permission) => <option key={permission} value={permission}>{permissionLabel(permission)}</option>)}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-reasoning`}><span>Reasoning</span>
          <select id={`${idPrefix}-reasoning`} value={value.reasoning ?? ""} disabled={busy} onChange={(event) => change({ ...value, reasoning: event.target.value as ProjectTaskAutomationDraft["reasoning"] })}>
            {reasoningOptions.map((reasoning) => <option key={reasoning} value={reasoning}>{reasoning}</option>)}
          </select>
        </label>
      </div>
      <label className="checkbox-row">
        <input
          id={`${idPrefix}-kickoff-enabled`}
          type="checkbox"
          checked={value.kickoffMessage !== null}
          disabled={busy}
          onChange={(event) => change({
            ...value,
            kickoffMessage: event.target.checked ? DEFAULT_TASK_KICKOFF_MESSAGE : null,
          })}
        />
        <span><strong>Send kickoff message</strong><small>Send the first visible message with the Task title, brief, and Jira link.</small></span>
      </label>
      {value.kickoffMessage !== null ? <>
        <label htmlFor={`${idPrefix}-kickoff-message`}>Kickoff message</label>
        <textarea
          id={`${idPrefix}-kickoff-message`}
          value={value.kickoffMessage}
          disabled={busy}
          rows={4}
          onChange={(event) => change({ ...value, kickoffMessage: event.target.value })}
        />
      </> : null}
    </> : null}
  </div>;
}
