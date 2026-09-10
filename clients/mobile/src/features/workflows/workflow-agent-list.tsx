import type { SessionDto, TaskDto } from "@termloop/contract/current";
import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ControlReadPort } from "../../application/ports";
import type { WorkflowTemplatesPort } from "../../application/workflow-templates-port";
import { Banner, Card, CardDivider } from "../../components/primitives";
import { JiraIssueLink } from "../../components/external-link";
import type { AgentCluster } from "../../presentation/attention-overview";
import { workflowAgentClusters, workflowAgentMemberships, type WorkflowAgentGroup, type WorkflowAgentMembership } from "../../presentation/workflow-agent-groups";
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
  const clusters = useMemo(() => workflowAgentClusters(props.clusters, memberships), [props.clusters, memberships]);
  const stale = !props.online || props.agentDataStale || Boolean(error);
  return <View style={styles.list}>
    {loading && !snapshot ? <Text style={styles.notice}>Loading workflow labels…</Text> : null}
    {error ? <Banner kind="warning" message={snapshot ? "Workflow labels may be out of date." : "Workflow labels could not be loaded."} action={props.online ? "Retry" : undefined} onAction={refresh} /> : null}
    <Card>{clusters.map((cluster, index) => <View key={cluster.key}>
      {index === 0 ? null : <CardDivider />}
      {props.renderCluster(cluster, memberships, stale)}
    </View>)}</Card>
  </View>;
}

export function WorkflowAgentGroupFrame({ group, stale, children }: { group: WorkflowAgentGroup; stale: boolean; children: ReactNode }) {
  const tint = stale ? color.textSecondary : group.tone === "done" ? color.success : group.tone === "quiet" ? color.textSecondary : toneColor[group.tone];
  const status = stale ? `Last known: ${group.status}` : group.status;
  return <View testID={`workflow-agent-group:${group.executionId}`} style={styles.group}>
    <View style={styles.header}>
      <View accessible accessibilityRole="header" accessibilityLabel={["Workflow", group.name, group.taskTitle, status].filter(Boolean).join(" · ")} style={styles.identity}>
        <View style={styles.workflowLine}>
          <Text style={styles.kind}>WORKFLOW</Text>
          <Text style={[styles.statusText, { color: tint }]}>{status}</Text>
        </View>
        <Text style={styles.name}>{group.name}</Text>
        {group.taskTitle ? <Text style={styles.task}>{group.taskTitle}</Text> : null}
      </View>
      <JiraIssueLink url={group.jiraUrl} />
    </View>
    <CardDivider />
    {children}
  </View>;
}

const styles = StyleSheet.create({
  list: { gap: space.sm }, notice: { color: color.textSecondary, fontSize: 12 },
  group: {
    minWidth: 0,
    margin: space.sm,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderLeftWidth: 3,
    borderLeftColor: color.accent,
    borderRadius: radius.card,
    backgroundColor: color.bgRaised,
    overflow: "hidden",
  },
  header: { paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.xs, backgroundColor: color.accentWash },
  identity: { minWidth: 0, gap: 4 },
  workflowLine: { flexDirection: "row", alignItems: "center", gap: space.sm, justifyContent: "space-between" },
  kind: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 9, fontWeight: "700", letterSpacing: 0.8 },
  name: { color: color.textSecondary, fontSize: 12, lineHeight: 17 },
  task: { color: color.text, fontSize: 16, lineHeight: 22, fontWeight: "600" },
  statusText: { flexShrink: 1, fontSize: 11, fontWeight: "600", textAlign: "right" },
});
