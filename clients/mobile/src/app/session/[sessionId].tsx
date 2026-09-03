import { useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Banner, StatePill } from "@/components/primitives";
import { ProjectSelector } from "@/components/project-selector";
import { MockBadge, Screen, ScreenHeader } from "@/components/screen";
import { TerminalView } from "@/components/terminal-view";
import { useConnections } from "@/features/connection/connection-store";
import {
  connectionRouteParams,
  missingSessionRouteState,
  resolveSessionRouteConnectionId,
} from "@/features/connection/connection-route";
import { useOverview } from "@/features/overview/overview-store";
import { SessionActionsSheet } from "@/features/session-actions/session-actions-sheet";
import { takePendingSessionInput } from "@/features/terminal/pending-session-input";
import { useTerminalSession, type TerminalKey } from "@/features/terminal/use-terminal-session";
import { mobileDiagnostics } from "@/platform/mobile-diagnostics";
import { keyboardAvoidingBehavior } from "@/platform/presentation";
import { buildProjectSummaries } from "@/presentation/attention-overview";
import { connectionPresentation } from "@/presentation/connection-presentation";
import { agentName, basename, sessionLabel, taskIdBySessionId } from "@/presentation/dto-readers";
import { sessionState } from "@/presentation/session-presentation";
import type { TerminalStreamState } from "@/presentation/terminal-buffer";
import type { RowTone } from "@/presentation/tone";
import { color, geometry, radius, space, terminalGeometry } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// The attached Session.
///
/// The Session identity owns the primary header row and the Project selector sits on a
/// compact second line — the reverse of every other screen, because here "which
/// terminal am I typing into" is the question that must never be ambiguous.
///
/// Transport state stays in the compact header pill. Routine attach/replay/reconnect
/// facts do not become banners or terminal lines; the Agent's content remains the
/// visual subject of this screen.

const streamPresentation: Record<TerminalStreamState, { label: string; tone: RowTone }> = {
  attaching: { label: "Attaching", tone: "busy" },
  live: { label: "Live", tone: "working" },
  reconnecting: { label: "Reconnecting", tone: "interrupted" },
  detached: { label: "Detached", tone: "quiet" },
  exited: { label: "Exited", tone: "blocked" },
};

const keyRow: readonly { key: TerminalKey; glyph: string; name: string }[] = [
  { key: "escape", glyph: "esc", name: "Escape" },
  { key: "tab", glyph: "tab", name: "Tab" },
  { key: "interrupt", glyph: "^C", name: "Interrupt" },
  { key: "eof", glyph: "^D", name: "End of input" },
  { key: "up", glyph: "↑", name: "Up" },
  { key: "down", glyph: "↓", name: "Down" },
  { key: "left", glyph: "←", name: "Left" },
  { key: "right", glyph: "→", name: "Right" },
  { key: "enter", glyph: "⏎", name: "Enter" },
];

type ImageSource = "library" | "camera";

export default function SessionRoute() {
  const { sessionId, connectionId } = useLocalSearchParams<{ sessionId: string; connectionId?: string }>();
  const router = useRouter();
  const focused = useIsFocused();
  const connections = useConnections();
  const store = useOverview();
  const [draft, setDraft] = useState("");
  const [selectedImage, setSelectedImage] = useState<ImagePicker.ImagePickerAsset | undefined>(undefined);
  const [imagePicking, setImagePicking] = useState(false);
  const [imageSending, setImageSending] = useState(false);
  const [fontSizeIndex, setFontSizeIndex] = useState(1);
  const [actionsOpen, setActionsOpen] = useState(false);
  const lastRouteDiagnostic = useRef<string | undefined>(undefined);

  const connectionScopes = useMemo(() => connections.connections.map((connection) => ({
    connectionId: connection.id,
    sessionIds: store.byConnection.get(connection.id)?.overview?.sessions.map(({ id }) => id) ?? [],
  })), [connections.connections, store.byConnection]);
  const resolvedRouteConnectionId = resolveSessionRouteConnectionId(
    connectionId,
    sessionId,
    connectionScopes,
  ) ?? (connectionId === undefined ? connections.selectedId : undefined);
  const selectingRouteConnection = resolvedRouteConnectionId !== undefined
    && connections.selectedId !== resolvedRouteConnectionId;
  const unresolvedScopedRoute = connectionId !== undefined
    && resolvedRouteConnectionId === undefined;
  const session = selectingRouteConnection || unresolvedScopedRoute
    ? undefined
    : store.overview?.sessions.find((candidate) => candidate.id === sessionId);
  const status = store.overview?.agentStatuses.find((candidate) => candidate.sessionId === sessionId);
  const changesTaskId = useMemo(() => {
    if (store.overview === undefined || session?.kind !== "Agent") return undefined;
    const taskId = taskIdBySessionId(store.overview.tasks).get(session.id);
    const task = store.overview.tasks.find((candidate) => candidate.id === taskId);
    return task?.worktree === null || task === undefined ? undefined : task.id;
  }, [session, store.overview]);
  const summaries = useMemo(
    () => (store.overview ? buildProjectSummaries(store.overview, store.reviewReadySessionIds) : []),
    [store.overview, store.reviewReadySessionIds],
  );
  const current = summaries.find((summary) => summary.project.id === session?.project_id);

  /// Expo Router retains earlier Session routes in its native stack. Only the
  /// visible route owns a terminal attachment; returning to a retained Agent then
  /// creates a clean attachment instead of reviving that screen's stale socket.
  const terminal = useTerminalSession(
    focused ? connections.selectedId : undefined,
    focused ? session : undefined,
  );
  const stream = streamPresentation[terminal.buffer.stream];
  useEffect(() => {
    if (resolvedRouteConnectionId !== undefined
      && connections.selectedId !== resolvedRouteConnectionId) {
      connections.select(resolvedRouteConnectionId);
    }
  }, [resolvedRouteConnectionId, connections.select, connections.selectedId]);
  useEffect(() => {
    if (sessionId) store.dismissReview(sessionId);
  }, [sessionId, store.dismissReview]);
  useEffect(() => {
    if (connections.selectedId === undefined || session === undefined) return;
    const pending = takePendingSessionInput(
      connections.selectedId,
      session.id,
      session.runtime_epoch,
    );
    if (pending !== undefined) setDraft((current) => current.length === 0 ? pending : current);
  }, [connections.selectedId, session?.id, session?.runtime_epoch]);

  const targetConnectionSelected = resolvedRouteConnectionId !== undefined
    && connections.selectedId === resolvedRouteConnectionId;
  const targetConnectionPresentation = targetConnectionSelected && connections.selected !== undefined
    ? connectionPresentation(connections.selected.availability)
    : undefined;
  const unresolvedSnapshots = connections.connections
    .map(({ id }) => store.byConnection.get(id));
  const routeState = missingSessionRouteState({
    catalogLoad: connections.load,
    selectingConnection: selectingRouteConnection,
    targetConnectionSelected,
    targetConnectionReadable: targetConnectionPresentation !== undefined
      && targetConnectionPresentation.block === undefined,
    overviewLoad: store.load,
    unresolvedProjectionsPending: unresolvedSnapshots.some((snapshot) => (
      snapshot === undefined || snapshot.load === "idle" || snapshot.load === "loading"
    )),
    unresolvedProjectionFailed: unresolvedSnapshots.some((snapshot) => snapshot?.load === "failed"),
  });
  const unresolvedOverviewError = targetConnectionSelected
    ? store.error
    : unresolvedSnapshots.find((snapshot) => snapshot?.load === "failed")?.error;
  const retryRoute = () => {
    connections.refresh();
    store.refresh();
  };
  useEffect(() => {
    if (session !== undefined || routeState === "loading") {
      lastRouteDiagnostic.current = undefined;
      return;
    }
    const signature = `${routeState}:${connectionId ?? "none"}:${resolvedRouteConnectionId ?? "none"}`;
    if (lastRouteDiagnostic.current === signature) return;
    lastRouteDiagnostic.current = signature;
    mobileDiagnostics.report("navigation", "session_route_unresolved", {
      connectionId,
      sessionId,
      hasResolvedConnection: resolvedRouteConnectionId !== undefined,
      pairedConnectionCount: connections.connections.length,
      reason: routeState,
    });
  }, [
    connectionId,
    connections.connections.length,
    resolvedRouteConnectionId,
    routeState,
    session,
    sessionId,
  ]);

  if (!session) {
    const placeholder = routeState === "loading"
      ? <ActivityIndicator color={color.accentStrong} />
      : routeState === "catalogFailed"
        ? (
          <Banner
            kind="danger"
            message={connections.error ?? "The saved Macs could not be read."}
            action="Retry"
            onAction={retryRoute}
          />
        )
        : routeState === "overviewFailed"
          ? (
            <Banner
              kind="danger"
              message={unresolvedOverviewError ?? "This Mac's sessions could not be read."}
              action="Retry"
              onAction={retryRoute}
            />
          )
          : routeState === "connectionBlocked"
            ? (
              <Banner
                kind="warning"
                message={targetConnectionPresentation?.summary ?? "This Mac is not available right now."}
                action="Retry"
                onAction={retryRoute}
              />
            )
            : (
              <Banner
                kind="warning"
                message="This session is no longer in a connected Mac's projection."
                action="Retry"
                onAction={retryRoute}
              />
            );
    return (
      <Screen edges={["top", "bottom"]}>
        <ScreenHeader back="Project" title="Session" right={<MockBadge />} />
        <View style={styles.centre}>
          {placeholder}
        </View>
      </Screen>
    );
  }

  const identity = session.kind === "Agent"
    ? sessionLabel(session)
    : `${basename(session.process.program)} · ${basename(session.process.cwd)}`;
  const projected = sessionState(session, status, store.reviewReadySessionIds.has(session.id));
  const exited = terminal.buffer.stream === "exited" || session.lifecycle_state === "exited";
  const dimmed = terminal.buffer.stream === "reconnecting";

  const chooseImage = async (source: ImageSource) => {
    if (imagePicking || imageSending || !terminal.canSend || session.kind !== "Agent") return;
    setImagePicking(true);
    try {
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          Alert.alert("Camera access needed", "Allow camera access to take a photo for this agent.");
          return;
        }
      }
      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ["images"],
        quality: 0.9,
      };
      const result = source === "camera"
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync(options);
      if (!result.canceled) setSelectedImage(result.assets[0]);
    } finally {
      setImagePicking(false);
    }
  };

  const chooseImageSource = () => {
    if (imagePicking || imageSending || !terminal.canSend || session.kind !== "Agent") return;
    Alert.alert("Attach a photo", "Send it with your next message to this agent.", [
      { text: "Take Photo", onPress: () => void chooseImage("camera") },
      { text: "Photo Library", onPress: () => void chooseImage("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const submit = async () => {
    if (selectedImage !== undefined) {
      setImageSending(true);
      try {
        const delivered = await terminal.submitWithImage(draft, {
          uri: selectedImage.uri,
          mediaType: selectedImage.mimeType ?? null,
        });
        if (delivered) {
          setDraft("");
          setSelectedImage(undefined);
        }
      } finally {
        setImageSending(false);
      }
      return;
    }
    terminal.submit(draft);
    setDraft("");
  };

  return (
    <Screen edges={["top", "bottom"]}>
      <View style={styles.header}>
        <ScreenHeader
          back="Project"
          center={
            <View style={styles.identityZone}>
              <Text style={styles.identity} numberOfLines={1}>{identity}</Text>
              {session.kind === "Agent" && projected.label !== undefined ? (
                <Text style={styles.projected} numberOfLines={1}>{projected.label}</Text>
              ) : null}
            </View>
          }
          right={
            <View style={styles.headerRight}>
              <StatePill tone={stream.tone} label={stream.label} />
              {changesTaskId === undefined ? null : (
                <Pressable
                  onPress={() => router.push({
                    pathname: "/task/[taskId]/changes",
                    params: connectionRouteParams(connections.selectedId, { taskId: changesTaskId }),
                  })}
                  accessibilityRole="button"
                  accessibilityLabel="Changes in this agent's worktree"
                  hitSlop={8}
                  style={styles.changesControl}
                >
                  <Text style={styles.changesControlLabel}>Changes</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => setFontSizeIndex((index) => (index + 1) % terminalGeometry.fontSizes.length)}
                accessibilityRole="button"
                accessibilityLabel={`Text size ${terminalGeometry.fontSizes[fontSizeIndex]} point. Tap to change.`}
                hitSlop={10}
                style={styles.fontControl}
              >
                <Text style={styles.fontControlGlyph}>Aa</Text>
              </Pressable>
              <Pressable
                onPress={() => setActionsOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Session actions"
                hitSlop={10}
                style={styles.menuControl}
              >
                <Text style={styles.menuControlGlyph}>•••</Text>
              </Pressable>
            </View>
          }
        />
        <View style={styles.subHeader}>
          <ProjectSelector current={current} variant="mini" />
          {session.kind === "Agent" ? (
            <Text style={styles.subDetail} numberOfLines={1}>{agentName(session)}</Text>
          ) : null}
          <MockBadge />
        </View>
      </View>

      {terminal.error === undefined && terminal.imageError === undefined ? null : (
        <View style={styles.notice}>
          <Banner kind="danger" message={terminal.error ?? terminal.imageError!} />
        </View>
      )}

      <View style={[styles.terminal, dimmed && styles.dimmed]}>
        <TerminalView
          key={`${connections.selectedId}:${session.id}:${session.runtime_epoch}`}
          buffer={terminal.buffer}
          fontSizeIndex={fontSizeIndex}
          capNotice={terminal.capNotice}
          onScrollBack={terminal.scrollBack}
        />
      </View>

      <KeyboardAvoidingView behavior={keyboardAvoidingBehavior}>
        {exited ? (
          <View style={styles.exited}>
            <Text style={styles.exitedText}>
              This session's process exited. Reopen it on your Mac.
            </Text>
          </View>
        ) : (
          <>
            {selectedImage === undefined ? null : (
              <View style={styles.imageAttachment}>
                <Image source={{ uri: selectedImage.uri }} style={styles.imagePreview} />
                <Text style={styles.imageAttachmentLabel} numberOfLines={1}>Photo attached</Text>
                <Pressable
                  onPress={() => setSelectedImage(undefined)}
                  disabled={imageSending}
                  accessibilityRole="button"
                  accessibilityLabel="Remove attached photo"
                  accessibilityState={{ disabled: imageSending }}
                  style={styles.removeImage}
                >
                  <Text style={styles.removeImageGlyph}>×</Text>
                </Pressable>
              </View>
            )}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.keys}
              keyboardShouldPersistTaps="always"
            >
              {keyRow.map((entry) => (
                <Pressable
                  key={entry.key}
                  onPress={() => terminal.sendKey(entry.key)}
                  disabled={!terminal.canSend}
                  accessibilityRole="button"
                  accessibilityLabel={entry.name}
                  accessibilityState={{ disabled: !terminal.canSend }}
                  style={({ pressed }) => [
                    styles.key,
                    pressed && terminal.canSend ? styles.keyPressed : null,
                    !terminal.canSend && styles.keyDisabled,
                  ]}
                >
                  <Text style={styles.keyGlyph}>{entry.glyph}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.composer}>
              {session.kind !== "Agent" ? null : (
                <Pressable
                  onPress={chooseImageSource}
                  disabled={!terminal.canSend || imagePicking || imageSending}
                  accessibilityRole="button"
                  accessibilityLabel="Attach a photo"
                  accessibilityState={{ disabled: !terminal.canSend || imagePicking || imageSending }}
                  style={({ pressed }) => [
                    styles.attach,
                    pressed && terminal.canSend ? styles.attachPressed : null,
                    (!terminal.canSend || imagePicking || imageSending) && styles.attachDisabled,
                  ]}
                >
                  <Text style={styles.attachGlyph}>▧</Text>
                </Pressable>
              )}
              <TextInput
                value={draft}
                onChangeText={setDraft}
                editable={terminal.canSend}
                placeholder={
                  terminal.canSend
                    ? session.kind === "Agent" ? `Message ${agentName(session)}…` : "Type a command…"
                    : exited ? "Session ended" : "Reconnecting…"
                }
                placeholderTextColor={color.textMuted}
                accessibilityLabel="Terminal input"
                multiline
                style={styles.input}
              />
              <Pressable
                onPress={() => void submit()}
                disabled={!terminal.canSend || imageSending || (draft.length === 0 && selectedImage === undefined)}
                accessibilityRole="button"
                accessibilityLabel="Send"
                style={({ pressed }) => [
                  styles.send,
                  pressed && styles.sendPressed,
                  (!terminal.canSend || imageSending || (draft.length === 0 && selectedImage === undefined)) && styles.sendDisabled,
                ]}
              >
                <Text style={styles.sendGlyph}>⏎</Text>
              </Pressable>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
      <SessionActionsSheet
        session={session}
        visible={actionsOpen}
        onClose={() => setActionsOpen(false)}
        onOpenSession={(targetSessionId) => {
          if (targetSessionId === session.id) return;
          router.replace({
            pathname: "/session/[sessionId]",
            params: connectionRouteParams(connections.selectedId, { sessionId: targetSessionId }),
          });
        }}
        onOpenTask={(taskId) => router.push({
          pathname: "/task/[taskId]",
          params: connectionRouteParams(connections.selectedId, { taskId }),
        })}
        onOpenChanges={(taskId) => router.push({
          pathname: "/task/[taskId]/changes",
          params: connectionRouteParams(connections.selectedId, { taskId }),
        })}
        onDismissed={() => router.back()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, justifyContent: "center", padding: space.screen },
  header: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.rule },
  identityZone: { flex: 1, minWidth: 0 },
  identity: { ...text.headerTitle },
  projected: { color: color.textSecondary, fontSize: 11 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: space.sm },
  changesControl: {
    minHeight: geometry.touchTarget,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  changesControlLabel: {
    color: color.accentStrong,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    fontWeight: "700",
  },
  fontControl: {
    minWidth: 30,
    height: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  fontControlGlyph: { color: color.textSecondary, fontSize: 13, fontWeight: "700" },
  menuControl: {
    minWidth: 30,
    height: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  menuControlGlyph: { color: color.textSecondary, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    /// Lines up under the header title, past the 28pt back chevron and the 12pt inset.
    paddingLeft: 40,
    paddingRight: space.md,
    paddingBottom: 9,
  },
  subDetail: { flex: 1, color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  notice: { paddingHorizontal: space.sm, paddingTop: space.sm },
  terminal: { flex: 1 },
  /// Dimmed rather than cleared while reconnecting. The last output a user saw is the
  /// most useful thing on the screen, and blanking it to signal a lost socket throws
  /// away the only context they have.
  dimmed: { opacity: 0.55 },
  keys: {
    gap: 5,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    alignItems: "center",
  },
  key: {
    /// Narrow enough that all nine fit a 390pt phone. Wider keys pushed the last one
    /// half off the edge, which reads as a rendering fault rather than as a scrollable
    /// row — and the row stays scrollable anyway on a smaller screen.
    minWidth: terminalGeometry.keyMinWidth,
    height: terminalGeometry.keyRowHeight,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.control,
    backgroundColor: color.bgRaised,
  },
  keyPressed: { backgroundColor: color.bgHover },
  keyDisabled: { opacity: 0.45 },
  keyGlyph: { color: color.textSecondary, fontFamily: fontFamily.mono, fontSize: 12.5 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.rule,
    backgroundColor: color.bgSidebar,
  },
  imageAttachment: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: space.md,
    marginTop: space.sm,
    padding: space.sm,
    borderWidth: 1,
    borderColor: color.accent,
    borderRadius: radius.control,
    backgroundColor: color.accentWash,
  },
  imagePreview: { width: 36, height: 36, borderRadius: 5, backgroundColor: color.bgHover },
  imageAttachmentLabel: { flex: 1, color: color.text, fontSize: 12, fontWeight: "600" },
  removeImage: { width: geometry.touchTarget, height: geometry.touchTarget, alignItems: "center", justifyContent: "center" },
  removeImageGlyph: { color: color.textSecondary, fontSize: 22, lineHeight: 22 },
  attach: {
    width: geometry.touchTarget,
    height: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.bgRaised,
  },
  attachPressed: { backgroundColor: color.bgHover },
  attachDisabled: { opacity: 0.45 },
  attachGlyph: { color: color.textSecondary, fontSize: 20, fontWeight: "700" },
  input: {
    flex: 1,
    minHeight: terminalGeometry.composerInputMin,
    maxHeight: terminalGeometry.composerInputMax,
    paddingHorizontal: space.md,
    paddingTop: 12,
    paddingBottom: 12,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.bgApp,
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  send: {
    width: 52,
    height: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    backgroundColor: color.accent,
  },
  sendPressed: { backgroundColor: color.accentStrong },
  sendDisabled: { backgroundColor: color.bgHover },
  sendGlyph: { color: color.onAccent, fontSize: 17, fontWeight: "700" },
  exited: {
    padding: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.rule,
    backgroundColor: color.bgSidebar,
  },
  exitedText: { color: color.textSecondary, fontSize: 13, textAlign: "center" },
});
