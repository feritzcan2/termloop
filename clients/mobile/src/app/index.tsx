import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  Banner,
  Card,
  CardDivider,
  EmptyState,
  PrimaryButton,
  SectionHeader,
} from "@/components/primitives";
import { ProjectAvatar, ProjectSelector } from "@/components/project-selector";
import { MockBadge, MockNotice, Screen, ScreenHeader } from "@/components/screen";
import { Row } from "@/components/row";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { buildLocatedProjectSummaries } from "@/presentation/attention-overview";
import { color, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// Home: every Project, with its Mac shown as location metadata.
///
/// Connection selection is navigation context, not a browsing step. Tapping a Project
/// selects its owning credential immediately before opening it, so identical UI can
/// safely address several Macs without merging their domain projections.
export default function HomeRoute() {
  const router = useRouter();
  const connections = useConnections();
  const overview = useOverview();
  const projects = buildLocatedProjectSummaries(connections.connections.flatMap((connection) => {
    const snapshot = overview.byConnection.get(connection.id);
    return snapshot?.overview === undefined ? [] : [{
      connection,
      overview: snapshot.overview,
      reviewReadySessionIds: snapshot.reviewReadySessionIds,
    }];
  }));
  const snapshots = [...overview.byConnection.values()];
  const projectReadsSettled = connections.load !== "loading"
    && snapshots.every((snapshot) => !snapshot.refreshing && snapshot.load !== "loading");
  const offlineNames = connections.connections
    .filter((connection) => connection.availability === "offline")
    .map((connection) => connection.name);
  const failedNames = connections.connections
    .filter((connection) => overview.byConnection.get(connection.id)?.load === "failed")
    .map((connection) => connection.name);

  /// The pull-to-refresh spinner reflects a pull and nothing else. Wired to background
  /// loading it sat spinning at the top of an untouched screen, next to the first-load
  /// indicator — two spinners for one wait, neither of them saying anything.
  const [pulled, setPulled] = useState(false);
  const settled = projectReadsSettled;
  useEffect(() => {
    if (pulled && settled) setPulled(false);
  }, [pulled, settled]);

  const firstLoad = connections.load === "loading" && connections.connections.length === 0;

  return (
    <Screen>
      <ScreenHeader
        center={<ProjectSelector current={undefined} />}
        right={(
          <View style={styles.headerRight}>
            <Pressable
              onPress={() => router.push("./settings")}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              hitSlop={12}
              style={styles.settingsButton}
            >
              <Text style={styles.settingsGlyph}>⚙</Text>
            </Pressable>
            <MockBadge />
          </View>
        )}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            onRefresh={() => {
              setPulled(true);
              connections.refresh();
              overview.refresh();
            }}
            tintColor={color.textSecondary}
          />
        }
      >
        <MockNotice detail="No Mac is contacted. Every project, session, and terminal byte below comes from a fixture in this build." />

        {connections.error === undefined ? null : (
          <Banner kind="danger" message={connections.error} action="Retry" onAction={connections.refresh} />
        )}

        {firstLoad ? (
          <View style={styles.loading}>
            <ActivityIndicator color={color.accentStrong} />
            {/*
              A bare spinner cannot be told apart from a frozen screen. Naming what is
              being waited on is the difference between "this is slow" and "this is
              broken", and only one of those is worth force-quitting the app over.
            */}
            <Text style={styles.loadingLabel}>Looking for your computers…</Text>
          </View>
        ) : null}

        {connections.load === "ready" && connections.connections.length === 0 ? (
          <EmptyState
            title="No computers paired"
            body="Pair the computer you run TermLoop on, and its projects and agents show up here."
          >
            <View style={styles.emptyAction}>
              <PrimaryButton label="Pair a computer" onPress={() => router.push("/pair")} />
            </View>
          </EmptyState>
        ) : null}

        {failedNames.length === 0 ? null : (
          <Banner
            kind="danger"
            message={`${failedNames.join(", ")} üzerindeki projeler okunamadı.`}
            action="Retry"
            onAction={overview.refresh}
          />
        )}

        {offlineNames.length === 0 ? null : (
          <Banner
            kind="warning"
            message={`${offlineNames.join(", ")} şu anda çevrimdışı; son bilinen proje ve agent durumu gösteriliyor, yeniden bağlantı otomatik deneniyor.`}
          />
        )}

        {projects.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader label="Tüm projeler" />
            <Card>
              {projects.map(({ connection, summary }, index) => (
                <View key={`${connection.id}:${summary.project.id}`}>
                  {index === 0 ? null : <CardDivider />}
                  <Row
                    tone={summary.tone}
                    eyebrow={connection.name}
                    title={summary.project.name}
                    detail={summary.summaryLine}
                    meta={summary.needsYouCount > 0 ? String(summary.needsYouCount) : undefined}
                    accessibleName={`${summary.project.name}, ${connection.name} üzerinde, ${summary.summaryLine}`}
                    trailing={<ProjectAvatar name={summary.project.name} size={21} />}
                    minHeight={68}
                    onPress={() => {
                      connections.select(connection.id);
                      router.push({
                        pathname: "/project/[projectId]",
                        params: { projectId: summary.project.id, connectionId: connection.id },
                      });
                    }}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {connections.connections.length > 0 && projects.length === 0 && projectReadsSettled ? (
          <EmptyState
            title="Henüz proje yok"
            body="Bağlı bilgisayarlarında bir proje açtığında burada, bulunduğu bilgisayarın adıyla birlikte görünecek."
          />
        ) : null}

        {connections.connections.length > 0 ? (
          <View style={styles.pair}>
            <PrimaryButton label="Pair a computer" onPress={() => router.push("/pair")} />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  settingsButton: { width: 34, height: 44, alignItems: "center", justifyContent: "center" },
  settingsGlyph: { color: color.textSecondary, fontSize: 18 },
  content: { gap: space.md, padding: space.screen, paddingBottom: space.xl },
  loading: { alignItems: "center", gap: space.md, paddingVertical: space.xl },
  loadingLabel: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 12 },
  emptyAction: { alignSelf: "stretch", marginTop: space.sm },
  section: { gap: 6 },
  pair: { marginTop: space.xs },
});
