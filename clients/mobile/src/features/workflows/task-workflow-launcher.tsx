import type { AgentStatusDto, SessionDto, TaskDto } from "@termloop/contract/current";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { ControlReadPort } from "../../application/ports";
import { WorkflowLaunchUnconfirmedError, type WorkflowLaunchPort } from "../../application/workflow-launch-port";
import type { WorkflowTemplatesPort } from "../../application/workflow-templates-port";
import { Banner, PrimaryButton } from "../../components/primitives";
import { launchBlockedReason } from "../../presentation/agent-launch-presentation";
import { workflowAgentName, workflowPermissionName, workflowSummary } from "../../presentation/workflow-template";
import { color, radius, space } from "../../theme/tokens";
import { WorkflowButton, WorkflowField, WorkflowSelect } from "./workflow-controls";
import { taskWorkflowExecution } from "../../presentation/workflow-execution";
import { useWorkflowSnapshot } from "./use-workflow-snapshot";
import { WorkflowExecutionCard } from "./workflow-execution-card";

export function TaskWorkflowLauncher(props: {
  task: TaskDto;
  connectionId: string;
  online: boolean;
  templates: WorkflowTemplatesPort;
  launch: WorkflowLaunchPort;
  control: ControlReadPort;
  sessions: readonly SessionDto[];
  statuses: readonly AgentStatusDto[];
  agentDataStale: boolean;
  openTemplates(): void;
  openSession(sessionId: string): void;
}) {
  const { task, connectionId, online, templates, control } = props;
  const { snapshot, loading, error: readError, checkedAt, refresh } = useWorkflowSnapshot(templates, control, connectionId, task.project_id, online);
  const [selection, setSelection] = useState("");
  // Undefined means untouched: a late description can still prefill the field.
  // Once edited, even an intentionally empty goal survives projection refreshes.
  const [editedGoal, setEditedGoal] = useState<string>();
  const goal = editedGoal ?? (task.brief?.trim() || task.title);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [startedSession, setStartedSession] = useState<string>();
  const [showNewWorkflow, setShowNewWorkflow] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    setSelection((current) => current || snapshot?.configurations[0]?.id || "");
    if (startedSession && snapshot?.executions.some((item) => item.coordinatorSessionId === startedSession)) setStartedSession(undefined);
  }, [snapshot, startedSession]);

  const configurations = snapshot?.configurations ?? [];
  const configuration = configurations.find((item) => item.id === selection);
  const execution = taskWorkflowExecution(snapshot?.executions ?? [], task.id);
  const active = execution?.status !== "completed" ? execution : undefined;
  const leadSession = active?.coordinatorSessionId ?? startedSession;
  const blocked = !online ? "Reconnect to your Mac to start. Your goal is kept here." : launchBlockedReason(task);
  const disabled = busy || unconfirmed || !!leadSession || !!blocked || !!readError || !snapshot || !configuration || !goal.trim() || goal.trim().length > 32_768;
  const start = async () => {
    if (busyRef.current || disabled || !configuration) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    try {
      const session = await props.launch.start(connectionId, { taskId: task.id, workflowId: configuration.id, goal }, configuration);
      if (mounted.current) { setStartedSession(session.id); setShowNewWorkflow(false); refresh(); }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (cause instanceof WorkflowLaunchUnconfirmedError) setUnconfirmed(true);
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
    // Stay on the Task: a workflow has multiple agents, not just one terminal.
    // The acknowledged lead is still available while its progress is loading.
  };

  return <View style={styles.card}>
    <View style={styles.header}><Text style={styles.title}>Workflow</Text><WorkflowButton label="Templates" disabled={busy} onPress={props.openTemplates} /></View>
    {execution ? <WorkflowExecutionCard key={execution.id} execution={execution} sessions={props.sessions} statuses={props.statuses} online={online} agentDataStale={props.agentDataStale} checkedAt={checkedAt} refreshing={loading} error={readError} refresh={refresh} openSession={props.openSession} /> : null}
    {startedSession && !active ? <>
      <Text style={styles.help}>Workflow started. Waiting for the Mac’s progress snapshot…</Text>
      <PrimaryButton label="Open workflow agent" disabled={!online} onPress={() => props.openSession(startedSession)} />
      <WorkflowButton label="Refresh progress" disabled={!online || loading} onPress={refresh} />
    </> : null}
    {execution?.status === "completed" && !startedSession && !showNewWorkflow ? <WorkflowButton label="Start another workflow" disabled={!online} onPress={() => setShowNewWorkflow(true)} /> : null}
    {!leadSession && (!execution || showNewWorkflow) ? <>
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
    </> : null}
    {blocked && !execution ? <Banner kind="warning" message={blocked} /> : null}
    {readError && !execution ? <Banner kind="danger" message={`Could not load workflows. Check the Mac and mobile gateway. ${readError}`} /> : null}
    {error && !leadSession ? <Banner kind="warning" message={error} /> : null}
    {(readError || error) && !execution ? <WorkflowButton label="Refresh workflows" disabled={!online || loading || busy} onPress={refresh} /> : null}
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
