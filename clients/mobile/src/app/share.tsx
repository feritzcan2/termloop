import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo } from "react";
import { ActivityIndicator, Image, ScrollView, Text, View } from "react-native";

import { Banner, Card, CardDivider, EmptyState, SectionHeader } from "@/components/primitives";
import { Row } from "@/components/row";
import { Screen, ScreenHeader } from "@/components/screen";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { shareInbox, validShareBatchId } from "@/platform/share-inbox";
import { shareLaunchTarget, shareMacs } from "@/presentation/share-target";
import { createThemedStyles, useTheme } from "@/theme/context";
import { radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// Entry point of the iOS share extension (`termloop://share?batch=…`). The
/// extension only stages the image; here the user picks where a new Agent starts
/// — any Project on any reachable Mac — then the ordinary launch screen takes the
/// prompt and agent settings.
export default function ShareRoute() {
  const { color } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const { batch } = useLocalSearchParams<{ batch?: string }>();
  const shareBatch = validShareBatchId(batch) ? batch : undefined;
  const image = useMemo(() => (shareBatch === undefined ? undefined : shareInbox.read(shareBatch)), [shareBatch]);
  const connections = useConnections();
  const store = useOverview();
  const macs = useMemo(
    () => shareMacs(connections.connections, store.byConnection),
    [connections.connections, store.byConnection],
  );

  /// Opening from the share sheet often lands while the phone is still
  /// re-establishing its Mac connections, so failed reads are retried rather
  /// than left as a dead end.
  const anyFailed = [...store.byConnection.values()].some((snapshot) => snapshot.load === "failed");
  useEffect(() => {
    if (!anyFailed) return;
    const timer = setInterval(store.refresh, 3_000);
    return () => clearInterval(timer);
  }, [anyFailed, store.refresh]);

  const start = (connectionId: string, projectId: string, taskId?: string) => {
    if (shareBatch === undefined) return;
    router.replace({
      pathname: "/launch/[taskId]",
      params: { taskId: shareLaunchTarget({ projectId, taskId }), connectionId, shareBatch },
    });
  };

  const reachable = macs.filter((mac) => mac.state !== "unavailable");
  const unavailable = macs.filter((mac) => mac.state === "unavailable");

  return (
    <Screen>
      <ScreenHeader back="Home" backFallback="/" title="Share to agent" />
      <ScrollView contentContainerStyle={styles.content}>
        {image === undefined ? (
          <Banner kind="warning" message="This shared image is no longer available. Share it again from Photos." action="Home" onAction={() => router.replace("/")} />
        ) : (
          <View style={styles.preview}>
            <Image source={{ uri: image.uri }} style={styles.image} resizeMode="contain" accessibilityLabel="Shared screenshot" />
            <Text style={styles.meta}>{Math.round(image.width)} × {Math.round(image.height)}</Text>
          </View>
        )}

        {image === undefined ? null : macs.length === 0 ? (
          <EmptyState title="No Mac paired" body="Pair TermLoop with your Mac, then share the screenshot again." />
        ) : reachable.length === 0 ? (
          <EmptyState title="No Mac reachable" body="None of your Macs is connected right now. Make sure a Mac is awake with TermLoop running.">
            <Banner kind="warning" message="Retrying automatically." action="Retry now" onAction={() => { connections.refresh(); store.refresh(); }} />
          </EmptyState>
        ) : reachable.map((mac) => (
          <View key={mac.connectionId} style={styles.section}>
            <SectionHeader label={mac.name} />
            {mac.state === "loading" ? (
              <View style={styles.waiting} accessibilityLiveRegion="polite">
                <ActivityIndicator color={color.accentStrong} />
                <Text style={styles.meta}>Loading projects…</Text>
              </View>
            ) : mac.targets.length === 0 ? (
              <Text style={styles.meta}>No projects on this Mac.</Text>
            ) : mac.targets.map(({ project, tasks }) => (
              <Card key={project.id}>
                <Row
                  tone="quiet"
                  title={project.name}
                  meta={project.folder_path}
                  accessibleName={`Start an agent in project ${project.name} on ${mac.name}`}
                  onPress={() => start(mac.connectionId, project.id)}
                />
                {tasks.map((task) => (
                  <View key={task.id}>
                    <CardDivider />
                    <Row
                      tone="quiet"
                      eyebrow="Task"
                      title={task.title}
                      meta={task.branch?.name}
                      accessibleName={`Start an agent in task ${task.title} on ${mac.name}`}
                      onPress={() => start(mac.connectionId, project.id, task.id)}
                    />
                  </View>
                ))}
              </Card>
            ))}
          </View>
        ))}

        {image === undefined || unavailable.length === 0 || reachable.length === 0 ? null : (
          <Text style={styles.meta}>Not reachable: {unavailable.map((mac) => mac.name).join(", ")}</Text>
        )}
      </ScrollView>
    </Screen>
  );
}

const useStyles = createThemedStyles(({ color }) => ({
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl },
  preview: { alignItems: "center", gap: space.xs },
  image: { width: "100%", height: 220, borderRadius: radius.card, backgroundColor: color.bgRaised },
  meta: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  section: { gap: space.sm },
  waiting: { flexDirection: "row", alignItems: "center", gap: space.sm },
}));
