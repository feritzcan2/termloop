import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { Banner, Card, CardDivider, EmptyState, SectionHeader } from "@/components/primitives";
import { Row } from "@/components/row";
import { MockBadge, Screen, ScreenHeader } from "@/components/screen";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { color, space } from "@/theme/tokens";

/// Settings that belong to this phone, rather than durable TermLoop Project
/// state. A Watch choice is kept per paired Mac and delivered over
/// WatchConnectivity as latest state, so an unreachable Watch receives it on
/// its next connection.
export default function SettingsRoute() {
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const overview = useOverview();
  const connectionId = connections.selected?.id;
  const projects = overview.overview?.projects ?? [];
  const [targetProjectId, setTargetProjectId] = useState<string | null | undefined>(undefined);
  const [savingProjectId, setSavingProjectId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (connectionId === undefined) {
      setTargetProjectId(undefined);
      return;
    }
    let cancelled = false;
    setTargetProjectId(undefined);
    setError(undefined);
    void runtime.watch.targetProject(connectionId).then(
      (projectId) => {
        if (!cancelled) setTargetProjectId(projectId);
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Watch settings could not be read.");
          setTargetProjectId(null);
        }
      },
    );
    return () => { cancelled = true; };
  }, [connectionId, runtime]);

  const choose = useCallback(async (projectId: string) => {
    if (connectionId === undefined || savingProjectId !== undefined) return;
    setSavingProjectId(projectId);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await runtime.watch.setTargetProject(connectionId, projectId);
      setTargetProjectId(projectId);
      setNotice(result.synced
        ? "Saved and sent to your Apple Watch."
        : "Saved. It will reach your Apple Watch when it reconnects.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Watch target could not be saved.");
    } finally {
      setSavingProjectId(undefined);
    }
  }, [connectionId, runtime, savingProjectId]);

  return (
    <Screen>
      <ScreenHeader back="Projects" title="Settings" right={<MockBadge />} />
      <ScrollView contentContainerStyle={styles.content}>
        {connectionId === undefined ? (
          <EmptyState
            title="No Mac selected"
            body="Select a paired Mac first, then choose where requests from its Apple Watch should go."
          />
        ) : projects.length === 0 ? (
          overview.load === "failed"
            ? <Banner kind="warning" message={overview.error ?? "Projects could not be read."} action="Retry" onAction={overview.refresh} />
            : <View style={styles.loading}><ActivityIndicator color={color.accentStrong} /></View>
        ) : (
          <>
            <View style={styles.intro}>
              <Text style={styles.title}>Watch requests</Text>
              <Text style={styles.body}>
                Dictation, the Action Button, and “Tell Stew” on your Apple Watch will start in this Project.
              </Text>
            </View>

            {targetProjectId === undefined ? <ActivityIndicator color={color.accentStrong} /> : null}
            {notice === undefined ? null : <Banner kind="info" message={notice} />}
            {error === undefined ? null : <Banner kind="warning" message={error} />}

            <View style={styles.section}>
              <SectionHeader label="Destination Project" />
              <Card>
                {projects.map((project, index) => {
                  const selected = targetProjectId === project.id;
                  const saving = savingProjectId === project.id;
                  return (
                    <View key={project.id}>
                      {index === 0 ? null : <CardDivider />}
                      <Row
                        tone={selected ? "working" : "quiet"}
                        title={project.name}
                        state={selected ? (saving ? "Saving" : "Selected") : undefined}
                        detail={selected ? "New Watch requests go here." : project.folder_path}
                        meta={selected ? "✓" : undefined}
                        accessibleName={`${project.name}${selected ? ", selected for Watch requests" : ""}`}
                        disabled={savingProjectId !== undefined}
                        onPress={() => void choose(project.id)}
                      />
                    </View>
                  );
                })}
              </Card>
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl },
  loading: { alignItems: "center", paddingVertical: space.xl },
  intro: { gap: space.xs },
  title: { color: color.text, fontSize: 18, fontWeight: "700" },
  body: { color: color.textSecondary, fontSize: 13, lineHeight: 19 },
  section: { gap: space.sm },
});
