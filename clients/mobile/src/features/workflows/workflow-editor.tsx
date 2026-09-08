import type { WorkflowConfigurationDto, WorkflowStepDto } from "@termloop/contract/current";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { WorkflowMutationUnconfirmedError, type WorkflowAgentCatalog } from "../../application/workflow-templates-port";
import { Banner, PrimaryButton } from "../../components/primitives";
import { Screen, ScreenHeader } from "../../components/screen";
import { keyboardAvoidingBehavior } from "../../platform/presentation";
import { addWorkflowStep, canMoveWorkflowStep, moveWorkflowStep, normalizedWorkflowDraft, removeWorkflowStep, sanitizeWorkflowReuse, startingWorkflowSteps, workflowAgentName, workflowDraft, workflowDraftError, workflowLaunchDefaults, workflowPermissionName, workflowStarts, workflowStepLabel, workflowStepOwner, type WorkflowDraft } from "../../presentation/workflow-template";
import { color, radius, space } from "../../theme/tokens";
import { WorkflowAdvanced, WorkflowButton, WorkflowField, WorkflowSelect } from "./workflow-controls";
import { WorkflowLaunchFields, WorkflowStepFields } from "./workflow-step-fields";

export function WorkflowEditor(props: {
  configuration: WorkflowConfigurationDto | undefined;
  currentConfiguration: WorkflowConfigurationDto | undefined;
  catalog: WorkflowAgentCatalog;
  online: boolean;
  close(): void;
  save(draft: WorkflowDraft, generation: number | undefined): Promise<void>;
  remove(generation: number): Promise<void>;
}) {
  const [draft, setDraft] = useState(() => workflowDraft(props.configuration));
  const [baseline, setBaseline] = useState(() => workflowDraft(props.configuration));
  const [generation, setGeneration] = useState(props.configuration?.generation);
  const [selectedStepId, selectStep] = useState<string>();
  const [confirmation, setConfirmation] = useState<"close" | "restart" | "delete">();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string>();
  const [unconfirmed, setUnconfirmed] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const scrollToStep = useRef<string | undefined>(undefined);
  const editing = props.configuration !== undefined;
  const choosing = !editing && draft.steps.length === 0;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const stale = editing && props.currentConfiguration?.generation !== generation;
  const reviews = draft.steps.filter((step) => step.kind === "review");
  const fix = draft.steps.some((step) => step.kind === "fix");
  const requestConfirmation = (action: "close" | "restart" | "delete") => {
    if (busyRef.current) return;
    if (action === "close" && !dirty) { props.close(); return; }
    setConfirmation(action);
    scroll.current?.scrollTo({ y: 0, animated: true });
  };
  const updateStep = (id: string, update: Partial<WorkflowStepDto>) => setDraft((current) => ({ ...current, steps: sanitizeWorkflowReuse(current.steps.map((step) => step.id === id ? { ...step, ...update } : step)) }));
  const addStep = (kind: "discuss" | "review" | "fix") => {
    const next = addWorkflowStep(draft.steps, kind);
    const added = next.find((step) => !draft.steps.some((previous) => previous.id === step.id));
    if (!added) return;
    const steps = next.map((step) => step === added && step.agentId ? { ...step, ...workflowLaunchDefaults(props.catalog.capabilities.find((item) => item.agent_id === step.agentId)) } : step);
    scrollToStep.current = added.id;
    selectStep(added.id);
    setDraft({ ...draft, steps });
  };
  const mutate = async (remove = false) => {
    if (busyRef.current || !props.online || stale || choosing || unconfirmed) return;
    if (!remove) {
      const validation = workflowDraftError(draft);
      if (validation) { setError(validation.message); selectStep(validation.stepId); scroll.current?.scrollTo({ y: 0, animated: true }); return; }
    }
    busyRef.current = true; setBusy(true); setError(undefined);
    try {
      if (remove && generation !== undefined) await props.remove(generation);
      else await props.save(normalizedWorkflowDraft(draft), generation);
      props.close();
    } catch (cause) {
      if (cause instanceof WorkflowMutationUnconfirmedError) setUnconfirmed(true);
      setError(cause instanceof Error ? cause.message : String(cause));
      scroll.current?.scrollTo({ y: 0, animated: true });
    } finally { busyRef.current = false; setBusy(false); }
  };
  return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => requestConfirmation("close")}>
    <SafeAreaProvider>
    <Screen>
      <ScreenHeader title={editing ? "Edit template" : "New template"} subtitle={editing ? baseline.name : choosing ? "1 of 2 · Choose a start" : "2 of 2 · Make it yours"} right={<WorkflowButton label="Close" disabled={busy} onPress={() => requestConfirmation("close")} />} />
      <KeyboardAvoidingView behavior={keyboardAvoidingBehavior} style={styles.body}>
        <ScrollView ref={scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          {!props.online ? <Banner kind="warning" message="Your Mac is unavailable. Your draft stays here; reconnect before saving." /> : null}
          {error ? <View accessibilityRole="alert"><Banner kind="danger" message={error} /></View> : null}
          {stale ? <View style={styles.notice}>
            <Text style={styles.help}>{props.currentConfiguration ? "This template changed on your Mac. Your draft is kept. Loading the saved version replaces it." : "This template was deleted on your Mac. Your draft cannot overwrite or recreate it."}</Text>
            {props.currentConfiguration ? <WorkflowButton label="Load saved version" disabled={busy} onPress={() => { const next = workflowDraft(props.currentConfiguration); setDraft(next); setBaseline(next); setGeneration(props.currentConfiguration?.generation); setError(undefined); selectStep(undefined); }} /> : null}
          </View> : null}
          {confirmation ? <View style={styles.notice} accessibilityRole="alert">
            <Text style={styles.noticeTitle}>{confirmation === "close" ? "Discard your unsaved changes?" : confirmation === "restart" ? "Replace your steps? Your name and lead agent settings will be kept." : "Delete this template from the project? It will no longer be available for new runs."}</Text>
            <View style={styles.actions}>
              <WorkflowButton label="Keep editing" disabled={busy} onPress={() => setConfirmation(undefined)} />
              <WorkflowButton label={confirmation === "close" ? "Discard changes" : confirmation === "restart" ? "Choose another start" : "Delete template"} danger disabled={busy || (confirmation === "delete" && (!props.online || stale || unconfirmed))} onPress={() => {
                if (confirmation === "close") props.close();
                else if (confirmation === "restart") { setDraft((current) => ({ ...current, steps: [] })); setConfirmation(undefined); selectStep(undefined); setError(undefined); }
                else void mutate(true);
              }} />
            </View>
          </View> : null}
          {choosing ? <>
            <Text style={styles.title}>Create a workflow template</Text>
            <Text style={styles.help}>Choose a starting point, then make it yours. These are examples, not your saved templates.</Text>
            {workflowStarts.map((start) => <Pressable key={start.id} accessibilityRole="button" accessibilityLabel={start.title} onPress={() => {
              setDraft((current) => ({ ...current, steps: startingWorkflowSteps(start.id).map((step) => step.agentId && !step.reuseStepId ? { ...step, ...workflowLaunchDefaults(props.catalog.capabilities.find((item) => item.agent_id === step.agentId)) } : step) }));
              scroll.current?.scrollTo({ y: 0, animated: true });
            }} style={styles.starter}>
              <Text style={styles.cardTitle}>{start.title}</Text><Text style={styles.help}>{start.detail}</Text><Text style={styles.route}>{start.route}</Text><Text style={styles.link}>Customize this workflow →</Text>
            </Pressable>)}
            <Text style={styles.help}>Creating a template does not start any agents. Templates are shared with desktop and reusable in every Task in this project.</Text>
          </> : <>
            <Text style={styles.title}>{editing ? `Edit “${baseline.name}”` : "Make this workflow yours"}</Text>
            <Text style={styles.help}>{editing ? "Changes apply to future runs across this project." : "Creates a new project template. Give each Task its own goal when you run it."}</Text>
            <WorkflowField label="Template name" value={draft.name} placeholder="e.g. Feature quality check" change={(name) => setDraft((current) => ({ ...current, name }))} maxLength={80} disabled={busy} />
            <WorkflowSelect label="Lead agent" value={draft.coordinatorAgentId} options={(["codex", "claude"] as const).map((id) => { const available = props.catalog.capabilities.some((item) => item.agent_id === id && item.available); return { value: id, label: `${workflowAgentName(id)}${available ? "" : " (unavailable)"}`, disabled: !available }; })} disabled={busy} change={(id) => setDraft((current) => ({ ...current, coordinatorAgentId: id as WorkflowDraft["coordinatorAgentId"], ...workflowLaunchDefaults(props.catalog.capabilities.find((item) => item.agent_id === id)) }))} />
            <WorkflowAdvanced title={`Lead agent settings · ${workflowPermissionName(draft.permission)}`} disabled={busy}>
              <WorkflowLaunchFields capability={props.catalog.capabilities.find((item) => item.agent_id === draft.coordinatorAgentId)} selection={draft} update={(value) => setDraft((current) => ({ ...current, ...value }))} disabled={busy} />
            </WorkflowAdvanced>
            <View><Text style={styles.sectionTitle}>Workflow steps · {draft.steps.length}/8</Text><Text style={styles.help}>Top to bottom. Tap a step to edit its instructions.</Text></View>
            <View style={styles.addSteps}>
              {(["discuss", "review", "fix"] as const).map((kind) => <WorkflowButton key={kind} label={kind === "discuss" ? "+ Discussion" : kind === "review" ? "+ Reviewer" : fix ? "Fix added" : "+ Fix findings"} disabled={busy || draft.steps.length >= 8 || (kind === "fix" && (fix || !reviews.length))} onPress={() => addStep(kind)} />)}
            </View>
            {!reviews.length ? <Text style={styles.help}>Add a reviewer to enable automatic fixes.</Text> : null}
            {draft.steps.length >= 8 ? <Text style={styles.help}>All 8 steps are used. Remove a step to add another.</Text> : null}
            {draft.steps.map((step, index) => <View key={step.id} style={styles.stepGroup} onLayout={(event) => {
              if (scrollToStep.current !== step.id) return;
              scrollToStep.current = undefined;
              scroll.current?.scrollTo({ y: event.nativeEvent.layout.y, animated: true });
            }}>
              {step.kind === "review" && draft.steps[index - 1]?.kind !== "review" ? <Text style={styles.phase}>{reviews.length > 1 ? `${reviews.length} parallel reviewers · run together` : "Independent review"}</Text> : null}
              {step.kind === "fix" ? <Text style={styles.phase}>After all reviews · only if changes are requested</Text> : null}
              <View style={[styles.step, selectedStepId === step.id && styles.stepSelected]}>
                <Pressable accessibilityRole="button" accessibilityLabel={`Edit step ${index + 1}: ${step.title || "Untitled step"}`} accessibilityState={{ expanded: selectedStepId === step.id, disabled: busy }} disabled={busy} onPress={() => selectStep(selectedStepId === step.id ? undefined : step.id)} style={styles.stepHead}>
                  <Text style={styles.number}>{index + 1}</Text><View style={styles.stepCopy}><Text style={styles.cardTitle}>{step.title || "Untitled step"}</Text><Text style={styles.help}>{workflowStepOwner(step, draft.steps, draft.coordinatorAgentId, props.catalog.profiles)}</Text><Text style={styles.kind}>{workflowStepLabel(step.kind)}{step.kind === "implement" ? " · required" : ""}</Text></View><Text style={styles.link}>{selectedStepId === step.id ? "⌃" : "⌄"}</Text>
                </Pressable>
                {selectedStepId === step.id ? <View style={styles.stepFields}>
                  <WorkflowStepFields step={step} draft={draft} catalog={props.catalog} disabled={busy} update={(update) => updateStep(step.id, update)} />
                  <View style={styles.actions}>
                    {step.kind === "discuss" || step.kind === "review" ? <>
                      <WorkflowButton label="↑ Move up" disabled={busy || !canMoveWorkflowStep(draft.steps, step.id, -1)} onPress={() => setDraft((current) => ({ ...current, steps: moveWorkflowStep(current.steps, step.id, -1) }))} />
                      <WorkflowButton label="↓ Move down" disabled={busy || !canMoveWorkflowStep(draft.steps, step.id, 1)} onPress={() => setDraft((current) => ({ ...current, steps: moveWorkflowStep(current.steps, step.id, 1) }))} />
                    </> : null}
                    {step.kind !== "implement" ? <WorkflowButton label="Remove step" danger disabled={busy} onPress={() => { setDraft((current) => ({ ...current, steps: removeWorkflowStep(current.steps, step.id) })); selectStep(undefined); }} /> : null}
                  </View>
                  {step.kind === "review" && reviews.length === 1 && fix ? <Text style={styles.help}>Removing the last reviewer also removes the fix step.</Text> : null}
                </View> : null}
              </View>
            </View>)}
            {fix ? <View style={styles.notice}>
              <Text style={styles.noticeTitle}>↳ Fixes go back to all reviewers</Text>
              <WorkflowSelect label="Maximum review rounds" value={String(draft.maxReviewCycles)} options={[1, 2, 3].map((value) => ({ value: String(value), label: `${value} ${value === 1 ? "round" : "rounds"}` }))} change={(value) => setDraft((current) => ({ ...current, maxReviewCycles: Number(value) }))} disabled={busy} />
              <Text style={styles.help}>Stops early if all reviewers approve. At the limit, the last fixes finish without another approval.</Text>
            </View> : null}
            <WorkflowButton label={editing ? "Delete template…" : "Change starting point"} danger={editing} disabled={busy} onPress={() => requestConfirmation(editing ? "delete" : "restart")} />
          </>}
        </ScrollView>
        {!choosing ? <View style={styles.footer}><Text style={styles.footerHelp}>{unconfirmed ? "Change unconfirmed · check saved templates" : dirty ? "Unsaved changes · no agents will start" : "Saved project template"}</Text><PrimaryButton label={busy ? "Saving…" : editing ? "Save changes" : "Create template"} busy={busy} disabled={busy || !dirty || stale || !props.online || unconfirmed} onPress={() => void mutate()} /></View> : null}
      </KeyboardAvoidingView>
    </Screen>
    </SafeAreaProvider>
  </Modal>;
}

const styles = StyleSheet.create({
  body: { flex: 1 }, content: { padding: space.screen, gap: space.lg, paddingBottom: space.xl },
  title: { color: color.text, fontSize: 23, fontWeight: "700", lineHeight: 29 }, help: { color: color.textSecondary, fontSize: 13, lineHeight: 19 },
  starter: { padding: space.lg, gap: space.md, backgroundColor: color.bgRaised, borderWidth: 1, borderColor: color.border, borderRadius: radius.card },
  cardTitle: { color: color.text, fontSize: 15, fontWeight: "600", lineHeight: 21 }, route: { color: color.accentStrong, fontSize: 13, lineHeight: 20, backgroundColor: color.accentWash, padding: 8, borderRadius: 6 },
  link: { color: color.accentStrong, fontSize: 14, fontWeight: "600" }, sectionTitle: { color: color.text, fontSize: 16, fontWeight: "700", marginBottom: 5 },
  addSteps: { flexDirection: "row", flexWrap: "wrap", borderWidth: 1, borderColor: color.border, borderRadius: radius.control },
  stepGroup: { gap: space.sm }, phase: { color: color.accentStrong, fontSize: 13, fontWeight: "600", lineHeight: 19 },
  step: { borderWidth: 1, borderColor: color.border, borderRadius: radius.card, backgroundColor: color.bgRaised }, stepSelected: { borderColor: color.accent },
  stepHead: { flexDirection: "row", gap: space.md, alignItems: "center", padding: space.md, minHeight: 76 }, stepCopy: { flex: 1, gap: 4 },
  number: { width: 28, height: 28, borderRadius: 14, textAlign: "center", lineHeight: 28, backgroundColor: color.accentWash, color: color.accentStrong, fontWeight: "700" },
  kind: { color: color.accentStrong, fontSize: 12 }, stepFields: { padding: space.md, gap: space.md, borderTopWidth: 1, borderTopColor: color.rule },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end" }, notice: { padding: space.md, gap: space.md, borderRadius: radius.control, backgroundColor: color.accentWash },
  noticeTitle: { color: color.text, fontSize: 14, lineHeight: 20, fontWeight: "600" }, footer: { padding: space.screen, gap: space.sm, borderTopWidth: 1, borderTopColor: color.rule }, footerHelp: { color: color.textSecondary, fontSize: 12 },
});
