import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Image, ScrollView, Text, View } from "react-native";

import { Banner, Card, CardDivider, EmptyState, SectionHeader } from "@/components/primitives";
import { Row } from "@/components/row";
import { Screen, ScreenHeader } from "@/components/screen";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { shareInbox, validShareBatchId } from "@/platform/share-inbox";
import { shareLaunchTarget, shareTargets } from "@/presentation/share-target";
import { createThemedStyles, useTheme } from "@/theme/context";
import { radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

/// Entry point of the iOS share extension (`termloop://share?batch=…`). The
/// extension only stages the image; here the user picks where a new Agent starts,
/// then the ordinary launch screen takes the prompt and agent settings.
export default function ShareRoute() {
  const { color } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const { batch } = useLocalSearchParams<{ batch?: string }>();
  const shareBatch = validShareBatchId(batch) ? batch : undefined;
  const image = useMemo(() => (shareBatch === undefined ? undefined : shareInbox.read(shareBatch)), [shareBatch]);
  const connections = useConnections();
  const store = useOverview();
  const targets = useMemo(
    () => (store.overview === undefined ? [] : shareTargets(store.overview.projects, store.overview.tasks)),
    [store.overview],
  );
  const connectionId = connections.selected?.id;

  const start = (projectId: string, taskId?: string) => {
    if (shareBatch === undefined || connectionId === undefined) return;
    router.replace({
      pathname: "/launch/[taskId]",
      params: { taskId: shareLaunchTarget({ projectId, taskId }), connectionId, shareBatch },
    });
  };

  return (
    <Screen>
      <ScreenHeader back="Home" backFallback="/" title="Share to agent" subtitle={connections.selected?.name} />
      <ScrollView contentContainerStyle={styles.content}>
        {image === undefined ? (
          <Banner kind="warning" message="This shared image is no longer available. Share it again from Photos." action="Home" onAction={() => router.replace("/")} />
        ) : (
          <View style={styles.preview}>
            <Image source={{ uri: image.uri }} style={styles.image} resizeMode="contain" accessibilityLabel="Shared screenshot" />
            <Text style={styles.meta}>{Math.round(image.width)} × {Math.round(image.height)}</Text>
          </View>
        )}

        {image === undefined ? null : connectionId === undefined ? (
          <EmptyState title="No Mac connected" body="Pair TermLoop with your Mac, then share the screenshot again." />
        ) : store.overview === undefined ? (
          store.load === "failed"
            ? <Banner kind="warning" message="Your Mac's projects could not be read." action="Retry" onAction={store.refresh} />
            : <ActivityIndicator color={color.accentStrong} />
        ) : targets.length === 0 ? (
          <EmptyState title="No projects" body="Add a project on your Mac to start an agent there." />
        ) : (
          <View style={styles.section}>
            <SectionHeader label="Start an agent in" />
            {targets.map(({ project, tasks }) => (
              <Card key={project.id}>
                <Row
                  tone="quiet"
                  title={project.name}
                  meta={project.folder_path}
                  accessibleName={`Start an agent in project ${project.name}`}
                  onPress={() => start(project.id)}
                />
                {tasks.map((task) => (
                  <View key={task.id}>
                    <CardDivider />
                    <Row
                      tone="quiet"
                      eyebrow="Task"
                      title={task.title}
                      meta={task.branch?.name}
                      accessibleName={`Start an agent in task ${task.title}`}
                      onPress={() => start(project.id, task.id)}
                    />
                  </View>
                ))}
              </Card>
            ))}
          </View>
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
}));
