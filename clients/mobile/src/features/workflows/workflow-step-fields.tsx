import type { AgentCapabilityDto, StewardAgentId, WorkflowStepDto } from "@termloop/contract/current";
import { StyleSheet, Text, View } from "react-native";
import type { WorkflowAgentCatalog } from "../../application/workflow-templates-port";
import { workflowAgentName, workflowHelper, workflowLaunchDefaults, workflowPermissionName, type WorkflowDraft } from "../../presentation/workflow-template";
import { color, space } from "../../theme/tokens";
import { WorkflowAdvanced, WorkflowField, WorkflowSelect } from "./workflow-controls";

export function WorkflowLaunchFields(props: {
  capability: AgentCapabilityDto | undefined;
  selection: Pick<WorkflowDraft, "model" | "permission" | "reasoning">;
  update(value: Partial<Pick<WorkflowDraft, "model" | "permission" | "reasoning">>): void;
  disabled: boolean;
}) {
  const { capability, selection, disabled } = props;
  return <>
    <WorkflowSelect label="Model" value={selection.model} options={(capability?.models ?? ["default"]).map((value) => ({ value, label: value === "default" ? "Default model" : value }))} disabled={disabled} change={(model) => props.update({ model })} />
    <WorkflowSelect label="Permission" value={selection.permission} options={(capability?.permissions ?? ["default"]).map((value) => ({ value, label: workflowPermissionName(value) }))} disabled={disabled} change={(permission) => props.update({ permission: permission as WorkflowDraft["permission"] })} />
    <WorkflowSelect label="Thinking" value={selection.reasoning} options={(capability?.reasoning ?? ["default"]).map((value) => ({ value, label: value === "default" ? "Default thinking" : value }))} disabled={disabled} change={(reasoning) => props.update({ reasoning: reasoning as WorkflowDraft["reasoning"] })} />
  </>;
}

export function WorkflowStepFields(props: {
  step: WorkflowStepDto; draft: WorkflowDraft; catalog: WorkflowAgentCatalog; disabled: boolean;
  update(value: Partial<WorkflowStepDto>): void;
}) {
  const { step, draft, catalog, disabled } = props;
  const prior = draft.steps.slice(0, draft.steps.findIndex((item) => item.id === step.id)).filter((item) => item.kind === "discuss");
  const taken = new Set(draft.steps.filter((item) => item.kind === "review" && item.id !== step.id).map((item) => item.reuseStepId));
  const capability = catalog.capabilities.find((item) => item.agent_id === step.agentId);
  const profiles = catalog.profiles.filter((profile) => profile.user_invocable && profile.agent_ids.includes(step.agentId ?? "claude")).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  const selectedProfile = catalog.profiles.find((profile) => profile.id === step.profileRef);
  const changeParticipant = (value: string) => {
    if (value.startsWith("reuse:")) {
      const source = prior.find((item) => item.id === value.slice(6));
      if (source) props.update({ agentId: source.agentId, reuseStepId: source.id, profileRef: null, model: null, permission: null, reasoning: null });
    } else {
      const agentId = value.slice(6) as StewardAgentId;
      const profile = selectedProfile?.agent_ids.includes(agentId) ? selectedProfile : undefined;
      props.update({ agentId, reuseStepId: null, profileRef: profile?.id ?? null, ...workflowLaunchDefaults(catalog.capabilities.find((item) => item.agent_id === agentId), profile) });
    }
  };
  return <View style={styles.fields}>
    <WorkflowField label="Step title" value={step.title} change={(title) => props.update({ title })} disabled={disabled} maxLength={120} />
    <WorkflowField label="Instructions" value={step.instructions} change={(instructions) => props.update({ instructions })} disabled={disabled} maxLength={4096} multiline />
    <Text style={styles.help}>Describe what this step should do. The Task goal is included automatically at run time.</Text>
    {workflowHelper(step) ? <>
      <WorkflowSelect label="Agent conversation" value={step.reuseStepId ? `reuse:${step.reuseStepId}` : `fresh:${step.agentId}`} change={changeParticipant} disabled={disabled} options={[
        ...(["codex", "claude"] as const).map((agentId) => { const available = catalog.capabilities.some((item) => item.agent_id === agentId && item.available); return { value: `fresh:${agentId}`, label: `New ${workflowAgentName(agentId)}${available ? "" : " (unavailable)"}`, disabled: !available }; }),
        ...(step.kind === "review" ? prior.map((item) => ({ value: `reuse:${item.id}`, label: `Continue ${workflowAgentName(item.agentId)} from “${item.title}”${taken.has(item.id) ? " (already assigned)" : ""}`, disabled: taken.has(item.id) })) : []),
      ]} />
      {step.reuseStepId ? <Text style={styles.help}>Continues the earlier discussion with its context, profile, model, permission and thinking settings.</Text> : <>
        <Text style={styles.help}>Starts a separate agent conversation, visible in this Task.</Text>
        <WorkflowSelect label="Agent profile (optional)" value={step.profileRef ?? ""} options={[
          { value: "", label: `No profile · default ${workflowAgentName(step.agentId)}` },
          ...profiles.map((profile) => ({ value: profile.id, label: `${profile.favorite ? "★ " : ""}${profile.name}` })),
        ]} disabled={disabled} change={(profileRef) => {
          const profile = profiles.find((item) => item.id === profileRef);
          props.update(profile ? { profileRef: profile.id, ...workflowLaunchDefaults(capability, profile) } : { profileRef: null });
        }} />
        <Text style={styles.help}>{selectedProfile?.description ?? "Optional expertise. Without a profile, the agent follows the step instructions."}</Text>
        <WorkflowAdvanced title="Model, permissions & thinking" disabled={disabled}>
          <WorkflowLaunchFields capability={capability} selection={{ model: step.model ?? "default", permission: step.permission ?? "bypassPermissions", reasoning: step.reasoning ?? "default" }} update={props.update} disabled={disabled} />
        </WorkflowAdvanced>
      </>}
    </> : <Text style={styles.owned}>{workflowAgentName(draft.coordinatorAgentId)} lead agent · {step.kind === "fix" ? "Applies the combined review findings" : "Works in the Task worktree"}. Uses the lead agent settings.</Text>}
  </View>;
}

const styles = StyleSheet.create({ fields: { gap: space.md }, help: { color: color.textSecondary, fontSize: 13, lineHeight: 19 }, owned: { color: color.accentStrong, fontSize: 13, lineHeight: 19, padding: space.md, backgroundColor: color.accentWash, borderRadius: 8 } });
