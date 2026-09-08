import type { WorkflowConfigurationDto, WorkflowConfigurationListResult } from "@termloop/contract/current";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ControlReadPort } from "../../application/ports";
import type { WorkflowAgentCatalog, WorkflowTemplatesPort } from "../../application/workflow-templates-port";
import { deleteWorkflowTemplate, saveWorkflowTemplate } from "../../application/workflow-template-commands";
import { Banner, EmptyState, PrimaryButton } from "../../components/primitives";
import { MockBadge, MockNotice, Screen, ScreenHeader } from "../../components/screen";
import { useAppLifecycle } from "../../platform/app-lifecycle";
import { workflowAgentName, workflowSummary } from "../../presentation/workflow-template";
import { color, radius, space } from "../../theme/tokens";
import { WorkflowButton } from "./workflow-controls";
import { WorkflowEditor } from "./workflow-editor";

export function WorkflowTemplatesScreen(props: {
  port: WorkflowTemplatesPort;
  control: ControlReadPort;
  connectionId: string;
  projectId: string;
  projectName: string;
  online: boolean;
}) {
  const { port, control, connectionId, projectId, online } = props;
  const lifecycle = useAppLifecycle();
  const [snapshot, setSnapshot] = useState<WorkflowConfigurationListResult>();
  const [catalog, setCatalog] = useState<WorkflowAgentCatalog>();
  const [editor, setEditor] = useState<{ configuration?: WorkflowConfigurationDto }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reload, setReload] = useState(0);
  const readSequence = useRef(0);
  const publish = useCallback((next: WorkflowConfigurationListResult) => {
    setSnapshot((current) => !current || next.stateRevision >= current.stateRevision ? next : current);
  }, []);

  useEffect(() => {
    if (!online || !lifecycle.active) { setLoading(false); return; }
    const sequence = ++readSequence.current;
    let active = true;
    setLoading(true);
    Promise.all([port.list(connectionId, projectId), port.catalog(connectionId)]).then(([next, nextCatalog]) => {
      if (!active || sequence !== readSequence.current) return;
      publish(next); setCatalog(nextCatalog); setError(undefined);
    }, (cause: unknown) => {
      if (active && sequence === readSequence.current) setError(`Could not load workflow templates. Make sure your Mac and mobile gateway are up to date. ${cause instanceof Error ? cause.message : String(cause)}`);
    }).finally(() => { if (active && sequence === readSequence.current) setLoading(false); });
    return () => { active = false; };
  }, [port, connectionId, projectId, online, lifecycle.active, lifecycle.foregroundRevision, reload, publish]);

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
  const existing = editor?.configuration;
  return <Screen>
    <ScreenHeader back="Project" title="Workflow templates" subtitle={props.projectName} right={<View style={styles.row}><WorkflowButton label="Refresh" disabled={loading || !online} onPress={() => setReload((value) => value + 1)} /><MockBadge /></View>} />
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading && snapshot !== undefined} onRefresh={() => setReload((value) => value + 1)} />}>
      <MockNotice detail="Templates in this development preview stay only in memory; they are not saved on a Mac." />
      <Text style={styles.title}>Your project workflows</Text>
      <Text style={styles.help}>Create reusable steps for your Tasks. These are the same templates you see on your Mac; saving one does not start any agents.</Text>
      {!online ? <Banner kind="warning" message="This project is unavailable. Reconnect to your Mac to manage its templates." /> : null}
      {error ? <Banner kind="danger" message={error} action="Retry" onAction={() => setReload((value) => value + 1)} /> : null}
      {notice ? <Banner kind="info" message={notice} /> : null}
      <PrimaryButton label="+ New template" disabled={!online || !catalog || !snapshot || configurations.length >= 16} onPress={() => { setNotice(undefined); setEditor({}); }} />
      {configurations.length >= 16 ? <Text style={styles.help}>All 16 template slots are used. Delete a template to make room.</Text> : null}
      {loading && !snapshot ? <ActivityIndicator color={color.accentStrong} /> : null}
      {snapshot && !configurations.length ? <EmptyState title="No saved templates yet" body="Start simple or use a guided example, then customize its agents and instructions." /> : null}
      {configurations.length ? <Text style={styles.count}>SAVED TEMPLATES · {configurations.length}/16</Text> : null}
      {configurations.map((configuration) => <Pressable key={configuration.id} accessibilityRole="button" accessibilityLabel={`Edit template: ${configuration.name}`} disabled={!online || !catalog} accessibilityState={{ disabled: !online || !catalog }} onPress={() => { setNotice(undefined); setEditor({ configuration }); }} style={styles.template}>
        <View style={styles.row}><Text style={styles.name}>{configuration.name}</Text><Text style={styles.link}>Edit →</Text></View>
        <Text style={styles.help}>{workflowAgentName(configuration.coordinatorAgentId)} lead · {configuration.steps.length} steps</Text>
        <Text style={styles.flow}>{workflowSummary(configuration.steps)}</Text>
      </Pressable>)}
    </ScrollView>
    {editor && catalog ? <WorkflowEditor configuration={existing} currentConfiguration={configurations.find((item) => item.id === existing?.id)} catalog={catalog} online={online} close={() => setEditor(undefined)} save={async (draft, generation) => {
      await saveWorkflowTemplate(port, { connectionId, projectId, ...(existing && generation !== undefined ? { existing: { id: existing.id, generation } } : {}) }, draft, publish);
      setNotice(existing ? "Template updated. Future runs use your changes." : "New template created. It is also available on your Mac.");
    }} remove={async (generation) => {
      if (!existing) return;
      await deleteWorkflowTemplate(port, { connectionId, projectId, existing: { id: existing.id, generation } }, publish);
      setNotice("Template deleted from this project.");
    }} /> : null}
  </Screen>;
}

const styles = StyleSheet.create({
  content: { padding: space.screen, gap: space.lg, paddingBottom: space.xl }, title: { color: color.text, fontSize: 23, fontWeight: "700" },
  help: { color: color.textSecondary, fontSize: 13, lineHeight: 20 }, count: { color: color.textMuted, fontSize: 11, letterSpacing: 1, fontWeight: "600" },
  template: { padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: color.border, borderRadius: radius.card, backgroundColor: color.bgRaised },
  row: { flexDirection: "row", alignItems: "center", gap: space.md }, name: { flex: 1, color: color.text, fontSize: 16, fontWeight: "600", lineHeight: 22 },
  link: { color: color.accentStrong, fontSize: 13, fontWeight: "600" }, flow: { color: color.accentStrong, fontSize: 13, lineHeight: 21 },
});
