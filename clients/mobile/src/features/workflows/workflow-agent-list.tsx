import type { SessionDto, TaskDto } from "@termloop/contract/current";
import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ControlReadPort } from "../../application/ports";
import type { WorkflowTemplatesPort } from "../../application/workflow-templates-port";
import { Banner, Card, CardDivider } from "../../components/primitives";
import type { AgentCluster } from "../../presentation/attention-overview";
import { workflowAgentMemberships, type WorkflowAgentGroup, type WorkflowAgentMembership } from "../../presentation/workflow-agent-groups";
import { color, radius, space, toneColor } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";
import { useWorkflowSnapshot } from "./use-workflow-snapshot";

/** The route keys this reader by Mac + Project so retained snapshots cannot cross scopes. */
export function WorkflowAgentList(props: {
  connectionId: string;
  projectId: string;
  online: boolean;
  agentDataStale: boolean;
  templates: WorkflowTemplatesPort;
  control: ControlReadPort;
  sessions: readonly SessionDto[];
  tasks: readonly TaskDto[];
  clusters: readonly AgentCluster[];
  renderCluster(cluster: AgentCluster, memberships: ReadonlyMap<string, WorkflowAgentMembership>, stale: boolean): ReactNode;
}) {
  const { snapshot, loading, error, refresh } = useWorkflowSnapshot(props.templates, props.control, props.connectionId, props.projectId, props.online);
  const memberships = useMemo(() => workflowAgentMemberships(snapshot?.executions ?? [], props.sessions, props.tasks, props.projectId), [snapshot, props.sessions, props.tasks, props.projectId]);
  const stale = !props.online || props.agentDataStale || Boolean(error);
  return <View style={styles.list}>
    {loading && !snapshot ? <Text style={styles.notice}>Loading workflow labels…</Text> : null}
    {error ? <Banner kind="warning" message={snapshot ? "Workflow labels may be out of date." : "Workflow labels could not be loaded."} action={props.online ? "Retry" : undefined} onAction={refresh} /> : null}
    <Card>{props.clusters.map((cluster, index) => <View key={cluster.key}>
      {index === 0 ? null : <CardDivider />}
      {props.renderCluster(cluster, memberships, stale)}
    </View>)}</Card>
  </View>;
}

export function WorkflowAgentGroupFrame({ group, stale, children }: { group: WorkflowAgentGroup; stale: boolean; children: ReactNode }) {
  const tint = stale ? color.textSecondary : group.tone === "done" ? color.success : group.tone === "quiet" ? color.textSecondary : toneColor[group.tone];
  const status = stale ? `Last known: ${group.status}` : group.status;
  return <View testID={`workflow-agent-group:${group.executionId}`} style={styles.group}>
    <View accessible accessibilityRole="header" accessibilityLabel={["Workflow", group.name, group.taskTitle, status].filter(Boolean).join(" · ")} style={styles.header}>
      <View style={styles.identity}>
        <Text style={styles.kind}>WORKFLOW</Text>
        <Text style={styles.name} numberOfLines={2}>{group.name}</Text>
        {group.taskTitle ? <Text style={styles.task} numberOfLines={1}>{group.taskTitle}</Text> : null}
      </View>
      <View style={[styles.status, { borderColor: tint }]}><Text style={[styles.statusText, { color: tint }]}>{status}</Text></View>
    </View>
    <CardDivider />
    {children}
  </View>;
}

const styles = StyleSheet.create({
  list: { gap: space.sm }, notice: { color: color.textSecondary, fontSize: 12 },
  group: { minWidth: 0, margin: 6, borderWidth: 1, borderColor: color.borderStrong, borderRadius: radius.card, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, backgroundColor: color.accentWash },
  identity: { flex: 1, minWidth: 0, gap: 3 },
  kind: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 10, fontWeight: "700", letterSpacing: 0.8 },
  name: { color: color.text, fontSize: 15, fontWeight: "700" },
  task: { color: color.textSecondary, fontSize: 12 },
  status: { maxWidth: "46%", flexShrink: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.control, paddingHorizontal: 7, paddingVertical: 4 },
  statusText: { fontSize: 11, fontWeight: "600", textAlign: "right" },
});
