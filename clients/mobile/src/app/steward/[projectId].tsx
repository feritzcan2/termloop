import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type { StewardMessage } from "@/application/ports";
import { Banner, UnavailableNote } from "@/components/primitives";
import { Screen, ScreenHeader } from "@/components/screen";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { relativeAge } from "@/presentation/relative-time";
import { color, geometry, radius, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

const POLL_MS = 6_000;

/// The Steward conversation for one Project.
///
/// This is the same transcript the desktop and the Watch append to: sending here
/// is an ordinary Companion transcript append, and the daemon's own chat wake
/// brings the Steward up. The phone holds no Steward authority of its own — it
/// cannot edit the Steward's instructions, and a proposal is answered by the
/// Steward's own named commands, never by the client acting on its behalf.
///
/// It is also how a pipeline gets built from a phone: ask the Steward, and it
/// edits the Playbook through its own Project-scoped commands.
export default function StewardRoute() {
  const { projectId, connectionId: routeConnectionId } = useLocalSearchParams<{
    projectId: string;
    connectionId?: string;
  }>();
  const router = useRouter();
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const selectingConnection = routeConnectionId !== undefined
    && connections.selectedId !== routeConnectionId;
  const selected = selectingConnection ? undefined : connections.selected;
  const store = useOverview();
  const project = store.overview?.projects.find((candidate) => candidate.id === projectId);
  const connectionId = selected?.id;

  const [messages, setMessages] = useState<readonly StewardMessage[] | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView | null>(null);
  const nowMs = store.readAtEpochMs ?? 0;

  useEffect(() => {
    if (routeConnectionId !== undefined && connections.selectedId !== routeConnectionId) {
      connections.select(routeConnectionId);
    }
  }, [connections.select, connections.selectedId, routeConnectionId]);

  const read = useCallback(async () => {
    if (connectionId === undefined || projectId === undefined) return;
    try {
      setMessages(await runtime.steward.transcript(connectionId, projectId));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [connectionId, projectId, runtime]);

  useEffect(() => {
    void read();
    // The Steward answers on its own schedule, so the transcript is polled while
    // this screen is open rather than waited on. Sending refreshes immediately.
    const handle = setInterval(() => { void read(); }, POLL_MS);
    return () => clearInterval(handle);
  }, [read]);

  const send = useCallback(async () => {
    if (connectionId === undefined || projectId === undefined) return;
    const content = draft.trim();
    if (content.length === 0) return;
    setBusy(true);
    try {
      setMessages(await runtime.steward.send(connectionId, projectId, content));
      setDraft("");
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [connectionId, draft, projectId, runtime]);

  const respond = useCallback(async (messageId: string, action: "approve" | "decline" | "accept") => {
    if (connectionId === undefined || projectId === undefined) return;
    setBusy(true);
    try {
      setMessages(await runtime.steward.respond(connectionId, projectId, messageId, action));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      void read();
    } finally {
      setBusy(false);
    }
  }, [connectionId, projectId, read, runtime]);

  if (selectingConnection) {
    return (
      <Screen>
        <ScreenHeader back="Project" title="Steward" />
        <View style={styles.centre}><ActivityIndicator color={color.accentStrong} /></View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader back="Project" title="Steward" subtitle={project?.name} />
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {messages === undefined ? (
          <View style={styles.centre}>
            {error === undefined
              ? <ActivityIndicator color={color.accentStrong} />
              : <Banner kind="warning" message={error} action="Retry" onAction={() => void read()} />}
          </View>
        ) : (
          <ScrollView
            ref={scroll}
            contentContainerStyle={styles.thread}
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
          >
            {messages.length === 0 ? (
              <UnavailableNote>
                No Steward conversation yet for this Project. Ask it something — it can read
                the Project and set up its delivery pipeline.
              </UnavailableNote>
            ) : messages.map((message) => (
              <StewardBubble
                key={message.id}
                message={message}
                nowMs={nowMs}
                busy={busy}
                respond={respond}
              />
            ))}
            {error === undefined ? null : (
              <View style={styles.threadError}><Banner kind="warning" message={error} /></View>
            )}
          </ScrollView>
        )}
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message the Steward"
            placeholderTextColor={color.textMuted}
            multiline
            editable={!busy}
            accessibilityLabel="Message the Steward"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send to the Steward"
            accessibilityState={{ disabled: busy || draft.trim().length === 0 }}
            disabled={busy || draft.trim().length === 0}
            onPress={() => void send()}
            style={[styles.send, busy || draft.trim().length === 0 ? styles.sendDisabled : null]}
          >
            <Text style={styles.sendLabel}>{busy ? "…" : "Send"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
      {project === undefined && store.load === "ready" ? (
        <View style={styles.centre}>
          <Banner
            kind="warning"
            message="This Project is no longer in the connected Mac's projection."
            action="Back"
            onAction={() => router.back()}
          />
        </View>
      ) : null}
    </Screen>
  );
}

/// A Steward message that is waiting on the user gets its own controls. Every
/// other kind is read-only: an approval already recorded is history, not a
/// prompt to answer twice.
function StewardBubble({ message, nowMs, busy, respond }: {
  message: StewardMessage;
  nowMs: number;
  busy: boolean;
  respond: (messageId: string, action: "approve" | "decline" | "accept") => Promise<void>;
}) {
  const mine = message.author === "user";
  return (
    <View style={[styles.bubbleWrap, mine ? styles.bubbleWrapMine : null]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : null]}>
        <Text style={[styles.bubbleText, mine ? styles.bubbleTextMine : null]}>{message.content}</Text>
        <Text style={styles.bubbleMeta}>
          {message.kind === "reply" ? "" : `${message.kind} · `}
          {nowMs === 0 ? "" : relativeAge(message.createdAtEpochMs, nowMs)}
        </Text>
      </View>
      {message.author === "steward" && message.kind === "proposal" ? (
        <View style={styles.bubbleActions}>
          <BubbleAction label="Approve" busy={busy} onPress={() => void respond(message.id, "approve")} accent />
          <BubbleAction label="Decline" busy={busy} onPress={() => void respond(message.id, "decline")} />
        </View>
      ) : null}
      {message.author === "steward" && message.kind === "suggestion" ? (
        <View style={styles.bubbleActions}>
          <BubbleAction label="Accept" busy={busy} onPress={() => void respond(message.id, "accept")} accent />
        </View>
      ) : null}
    </View>
  );
}

function BubbleAction({ label, busy, accent, onPress }: {
  label: string;
  busy: boolean;
  accent?: boolean | undefined;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={[styles.bubbleAction, accent === true ? styles.bubbleActionAccent : null]}
    >
      <Text style={[styles.bubbleActionLabel, accent === true ? styles.bubbleActionLabelAccent : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centre: { flex: 1, justifyContent: "center", padding: space.screen },
  thread: { gap: space.sm, padding: space.screen, paddingBottom: space.lg },
  threadError: { paddingTop: space.sm },
  bubbleWrap: { alignItems: "flex-start", gap: 6, maxWidth: "88%" },
  bubbleWrapMine: { alignSelf: "flex-end", alignItems: "flex-end" },
  bubble: {
    borderRadius: radius.card,
    backgroundColor: color.bgRaised,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 4,
  },
  bubbleMine: { backgroundColor: color.accentWash },
  bubbleText: { ...text.body, color: color.text, lineHeight: 19 },
  bubbleTextMine: { color: color.text },
  bubbleMeta: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 10 },
  bubbleActions: { flexDirection: "row", gap: space.sm },
  bubbleAction: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.control,
    backgroundColor: color.bgHover,
  },
  bubbleActionAccent: { backgroundColor: color.accent },
  bubbleActionLabel: { color: color.textSecondary, fontSize: 12, fontWeight: "700" },
  bubbleActionLabelAccent: { color: color.onAccent },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    padding: space.screen,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.rule,
    backgroundColor: color.bgApp,
  },
  input: {
    flex: 1,
    minHeight: geometry.touchTarget,
    maxHeight: 120,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.borderStrong,
    backgroundColor: color.bgRaised,
    color: color.text,
    fontSize: 14,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  send: {
    minHeight: geometry.touchTarget,
    justifyContent: "center",
    paddingHorizontal: space.lg,
    borderRadius: radius.control,
    backgroundColor: color.accent,
  },
  sendDisabled: { backgroundColor: color.bgHover },
  sendLabel: { color: color.onAccent, fontSize: 14, fontWeight: "700" },
});
