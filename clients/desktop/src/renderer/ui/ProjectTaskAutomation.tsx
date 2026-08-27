import type {
  AgentCapabilityDto,
  ProjectTaskAutomationGetResult,
  ProjectTaskAutomationSetParams,
  ProjectTaskAutomationSetResult,
} from "@termloop/contract/current";
import {
  agentLaunchDefaults,
  agentChoiceOptions,
  DEFAULT_TASK_KICKOFF_MESSAGE,
  type ProjectTaskAutomationDraft,
} from "../project-task-automation.js";

export type ProjectTaskAutomationActions = {
  getProjectAutomation(projectId: string): Promise<ProjectTaskAutomationGetResult>;
  setProjectAutomation(params: ProjectTaskAutomationSetParams): Promise<ProjectTaskAutomationSetResult>;
};

/// Create worktree / start agent, the two facts a new Task carries. The same
/// control renders the Project default and an explicit one-shot import choice,
/// keeping both surfaces aligned without making a provider own the default.
export function WorktreeAgentChoice({ idPrefix, value, busy, agentCapabilities, worktreeHint, agentHint, change }: {
  idPrefix: string;
  value: ProjectTaskAutomationDraft;
  busy: boolean;
  agentCapabilities: readonly AgentCapabilityDto[];
  worktreeHint: string;
  agentHint: string;
  change(next: ProjectTaskAutomationDraft): void;
}) {
  const options = agentChoiceOptions(agentCapabilities, value.agentId);
  const startAgent = value.agentId !== null;
  const noAgentAvailable = options.every((option) => !option.available);
  const selectedCapability = value.agentId === null
    ? undefined
    : agentCapabilities.find((capability) => capability.agent_id === value.agentId);
  const modelOptions = selectedCapability?.models ?? (value.model ? [value.model] : []);
  const reasoningOptions = selectedCapability?.reasoning ?? (value.reasoning ? [value.reasoning] : []);
  return <div className="task-automation-choices">
    <label className="checkbox-row">
      <input
        id={`${idPrefix}-worktree`}
        type="checkbox"
        checked={value.createWorktree}
        disabled={busy || startAgent}
        onChange={(event) => change(event.target.checked
          ? { ...value, createWorktree: true }
          : { createWorktree: false, agentId: null, model: null, reasoning: null, kickoffMessage: null })}
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
            ? { createWorktree: true, agentId, ...agentLaunchDefaults(agentCapabilities, agentId), kickoffMessage: null }
            : { ...value, agentId: null, model: null, reasoning: null, kickoffMessage: null });
        }}
      />
      <span><strong>Start agent</strong><small>{!startAgent && noAgentAvailable ? "No configured agent is currently available." : agentHint}</small></span>
    </label>
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
