import type { TaskDto, WorkflowConfigurationListResult } from "@termloop/contract/current";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { ControlReadPort } from "../../application/ports";
import { WorkflowLaunchUnconfirmedError, type WorkflowLaunchPort } from "../../application/workflow-launch-port";
import type { WorkflowTemplatesPort } from "../../application/workflow-templates-port";
import { Banner, PrimaryButton } from "../../components/primitives";
import { useAppLifecycle } from "../../platform/app-lifecycle";
import { launchBlockedReason } from "../../presentation/agent-launch-presentation";
import { workflowAgentName, workflowPermissionName, workflowSummary } from "../../presentation/workflow-template";
import { color, radius, space } from "../../theme/tokens";
import { WorkflowButton, WorkflowField, WorkflowSelect } from "./workflow-controls";

export function TaskWorkflowLauncher(props: {
  task: TaskDto;
  connectionId: string;
  online: boolean;
  templates: WorkflowTemplatesPort;
  launch: WorkflowLaunchPort;
  control: ControlReadPort;
  openTemplates(): void;
  openSession(sessionId: string): void;
}) {
  const { task, connectionId, online, templates, control } = props;
  const lifecycle = useAppLifecycle();
  const [snapshot, setSnapshot] = useState<WorkflowConfigurationListResult>();
  const [selection, setSelection] = useState("");
  // Undefined means untouched: a late description can still prefill the field.
  // Once edited, even an intentionally empty goal survives projection refreshes.
  const [editedGoal, setEditedGoal] = useState<string>();
  const goal = editedGoal ?? (task.brief?.trim() || task.title);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [startedSession, setStartedSession] = useState<string>();
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useFocusEffect(useCallback(() => {
    if (!online || !lifecycle.active) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    templates.list(connectionId, task.project_id).then((next) => {
      if (!active) return;
      setSnapshot((current) => !current || next.stateRevision >= current.stateRevision ? next : current);
      setSelection((current) => current || next.configurations[0]?.id || "");
      setReadError(undefined);
    }, (cause: unknown) => {
      if (active) setReadError(`Could not load workflows. Check that your Mac and mobile gateway are up to date. ${cause instanceof Error ? cause.message : String(cause)}`);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [templates, connectionId, task.project_id, online, lifecycle.active, lifecycle.foregroundRevision, reload]));

  useEffect(() => {
    if (!online || !lifecycle.active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = control.subscribeInvalidations(connectionId, (event) => {
      if (!event.topics.includes("workflow") || timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; setReload((value) => value + 1); }, 200);
    });
    return () => { stop(); if (timer !== undefined) clearTimeout(timer); };
  }, [control, connectionId, online, lifecycle.active]);

  const configurations = snapshot?.configurations ?? [];
  const configuration = configurations.find((item) => item.id === selection);
  const active = snapshot?.executions.find((item) => item.taskId === task.id && item.status !== "completed");
  const acknowledgedCompleted = snapshot?.executions.some((item) => item.coordinatorSessionId === startedSession && item.status === "completed");
  const leadSession = active?.coordinatorSessionId ?? (acknowledgedCompleted ? undefined : startedSession);
  const blocked = !online ? "Reconnect to your Mac to start. Your goal is kept here." : launchBlockedReason(task);
  const disabled = busy || unconfirmed || !!leadSession || !!blocked || !!readError || loading || !configuration || !goal.trim() || goal.trim().length > 32_768;
  const start = async () => {
    if (busyRef.current || disabled || !configuration) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    let sessionId: string | undefined;
    try {
      const session = await props.launch.start(connectionId, { taskId: task.id, workflowId: configuration.id, goal }, configuration);
      sessionId = session.id;
      if (mounted.current) setStartedSession(session.id);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (cause instanceof WorkflowLaunchUnconfirmedError) setUnconfirmed(true);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
    // Navigation is not launch acknowledgement; a navigation failure must never
    // invite another command. The acknowledged lead remains available to open.
    if (sessionId && mounted.current) props.openSession(sessionId);
  };

  return <View style={styles.card}>
    <View style={styles.header}><Text style={styles.title}>Workflow</Text><WorkflowButton label="Templates" disabled={busy} onPress={props.openTemplates} /></View>
    {leadSession ? <>
      <Text style={styles.help}>{active ? `${active.workflowName} · ${active.status === "paused" ? "Paused" : active.steps[active.currentStepIndex]?.title ?? "Running"}` : "Workflow started"}</Text>
      <PrimaryButton label="Open workflow agent" disabled={!online} onPress={() => props.openSession(leadSession)} />
    </> : <>
      <Text style={styles.help}>Choose a template and start its agents on this Task.</Text>
      {loading && !snapshot ? <ActivityIndicator color={color.accentStrong} /> : null}
      {configurations.length ? <>
        <WorkflowSelect label="Workflow template" value={selection} options={configurations.map((item) => ({ value: item.id, label: item.name }))} change={setSelection} disabled={busy || unconfirmed} />
        {configuration ? <>
          <Text style={styles.flow}>{workflowSummary(configuration.steps)}</Text>
          <Text style={styles.help}>{workflowAgentName(configuration.coordinatorAgentId)} lead · {workflowPermissionName(configuration.permission)}</Text>
        </> : <Text style={styles.help}>This template is no longer available. Choose another one.</Text>}
        <WorkflowField label="Workflow goal" value={goal} change={setEditedGoal} disabled={busy || unconfirmed} multiline maxLength={32_768} placeholder="What should the agents accomplish?" />
        <Text style={styles.hint}>{editedGoal === undefined ? (task.brief?.trim() ? "Filled from the Task description. You can edit it here." : "Filled from the Task title. Add details if needed.") : "Only this workflow run uses this goal. The Task description is unchanged."}</Text>
        <PrimaryButton label={busy ? "Starting workflow…" : "Start workflow"} disabled={disabled} onPress={() => { void start(); }} />
      </> : snapshot && !readError ? <>
        <Text style={styles.help}>No workflow templates in this project yet. Create one on your phone or Mac, then return here to start it.</Text>
        <PrimaryButton label="Create workflow template" disabled={!online} onPress={props.openTemplates} />
      </> : null}
    </>}
    {blocked ? <Banner kind="warning" message={blocked} /> : null}
    {readError ? <Banner kind="danger" message={readError} /> : null}
    {error && !leadSession ? <Banner kind="warning" message={error} /> : null}
    {readError || error ? <WorkflowButton label="Refresh workflows" disabled={!online || loading || busy} onPress={() => setReload((value) => value + 1)} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.bgRaised, borderWidth: 1, borderColor: color.borderStrong, borderRadius: radius.card, padding: space.lg, gap: space.md },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: color.text, fontSize: 19, fontWeight: "700" },
  help: { color: color.textSecondary, fontSize: 13, lineHeight: 20 },
  hint: { color: color.textMuted, fontSize: 12, lineHeight: 18 },
  flow: { color: color.accentStrong, fontSize: 13, lineHeight: 21 },
});
