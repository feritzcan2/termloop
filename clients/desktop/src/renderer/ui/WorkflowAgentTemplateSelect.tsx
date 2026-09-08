import type { AgentLibraryEntry, StewardAgentId } from "@termloop/contract/current";

type WorkflowAgentTemplateSelectProps = {
  id: string;
  profiles: readonly AgentLibraryEntry[];
  agentId: StewardAgentId;
  value: string | null;
  select(profileRef: string | null): void;
};

export function WorkflowAgentTemplateSelect(props: WorkflowAgentTemplateSelectProps) {
  const profiles = workflowAgentTemplates(props.profiles, props.agentId);
  const selected = props.profiles.find((profile) => profile.id === props.value);
  const groups = [
    { label: "Favorites", profiles: profiles.filter((profile) => profile.favorite) },
    { label: "My agents", profiles: profiles.filter((profile) => !profile.favorite && profile.source === "personal") },
    { label: "Built-in", profiles: profiles.filter((profile) => !profile.favorite && profile.source === "builtIn") },
  ].filter((group) => group.profiles.length > 0);

  return <div className="workflow-agent-template">
    <label htmlFor={props.id}>Agent template</label>
    <select
      id={props.id}
      aria-label="Agent template"
      value={props.value ?? ""}
      onChange={(event) => props.select(event.target.value || null)}
    >
      <option value="">Generic {agentLabel(props.agentId)}</option>
      {props.value && !selected ? <option value={props.value}>Unavailable template</option> : null}
      {groups.map((group) => <optgroup key={group.label} label={group.label}>
        {group.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </optgroup>)}
    </select>
    {selected ? <div className="workflow-agent-template-summary">
      <span aria-hidden="true">◎</span>
      <span><b>{selected.name}</b><small>{selected.description}</small></span>
      <em>{selected.category}</em>
    </div> : <p className="field-help">Uses this step's instructions without a saved agent template.</p>}
  </div>;
}

export function workflowAgentTemplates(
  profiles: readonly AgentLibraryEntry[],
  agentId: StewardAgentId,
): readonly AgentLibraryEntry[] {
  return profiles
    .filter((profile) => profile.user_invocable && profile.agent_ids.includes(agentId))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function agentLabel(agentId: StewardAgentId): string {
  return agentId === "claude" ? "Claude" : "Codex";
}
