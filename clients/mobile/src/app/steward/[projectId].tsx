import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { StewardMessage } from "@/application/ports";
import { Banner, UnavailableNote } from "@/components/primitives";
import { Screen, ScreenHeader } from "@/components/screen";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import { relativeAge } from "@/presentation/relative-time";
import { stewardLocalSpeech } from "@/platform/steward-local-speech";
import {
  configureStewardAudioSession,
  stewardVoiceAudioErrorMessage,
} from "@/platform/steward-voice-audio";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

const POLL_MS = 6_000;

/// Steward's asynchronous Project inbox.
///
/// Mobile sends new turns through the global voice-message composer. This route
/// remains the durable transcript and decision surface: it refreshes replies,
/// opens from push notifications, and can read any Steward response aloud without
/// pretending the delayed work is a live call.
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
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | undefined>(undefined);
  const [speechError, setSpeechError] = useState<string | undefined>(undefined);
  const scroll = useRef<ScrollView | null>(null);
  const speechAttempt = useRef(0);
  const speechFile = useRef<File | undefined>(undefined);
  const player = useAudioPlayer(null, { updateInterval: 100 });
  const playerStatus = useAudioPlayerStatus(player);
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
    // Replies are asynchronous and normally announced by push. Polling only keeps
    // an already-open inbox fresh; it is not exposed as a live typing state.
    const handle = setInterval(() => { void read(); }, POLL_MS);
    return () => clearInterval(handle);
  }, [read]);

  const cleanSpeechFile = useCallback(() => {
    const file = speechFile.current;
    speechFile.current = undefined;
    if (file?.exists) {
      try { file.delete(); } catch { /* The cache may evict speech first. */ }
    }
  }, []);

  const stopSpeech = useCallback(() => {
    speechAttempt.current += 1;
    player.pause();
    stewardLocalSpeech.stop();
    cleanSpeechFile();
    setSpeakingMessageId(undefined);
  }, [cleanSpeechFile, player]);

  const readAloud = useCallback(async (message: StewardMessage) => {
    if (connectionId === undefined) {
      setSpeechError("Steward yanıtını okumak için Mac bağlantısı gerekli.");
      return;
    }
    if (speakingMessageId === message.id) {
      stopSpeech();
      return;
    }
    stopSpeech();
    const attempt = speechAttempt.current;
    setSpeakingMessageId(message.id);
    setSpeechError(undefined);
    try {
      await configureVoicePlaybackAudio();
      const audio = await runtime.steward.speech(connectionId, projectId, message.sequence);
      if (attempt !== speechAttempt.current) return;
      const file = new File(Paths.cache, `termloop-steward-message-${message.sequence}.mp3`);
      file.write(audio);
      speechFile.current = file;
      player.replace(file.uri);
      player.play();
    } catch (remoteCause) {
      if (attempt !== speechAttempt.current) return;
      try {
        await configureVoicePlaybackAudio();
        const spoken = await stewardLocalSpeech.speak(message.content);
        if (!spoken) throw new Error("iPhone seslendirmesi kullanılamıyor.");
        if (attempt === speechAttempt.current) setSpeakingMessageId(undefined);
      } catch (localCause) {
        if (attempt !== speechAttempt.current) return;
        const remoteMessage = stewardVoiceAudioErrorMessage(remoteCause, "Mac sesi üretilemedi.");
        const localMessage = stewardVoiceAudioErrorMessage(localCause, "iPhone da okuyamadı.");
        setSpeechError(remoteMessage === localMessage ? remoteMessage : `${remoteMessage} ${localMessage}`);
        setSpeakingMessageId(undefined);
      }
    }
  }, [connectionId, player, projectId, runtime, speakingMessageId, stopSpeech]);

  useEffect(() => {
    if (!playerStatus.didJustFinish) return;
    cleanSpeechFile();
    setSpeakingMessageId(undefined);
  }, [cleanSpeechFile, playerStatus.didJustFinish]);

  useEffect(() => () => stopSpeech(), [stopSpeech]);

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
          <Banner
            kind="info"
            message="Sesli mesajını gönder; Steward yanıtladığında bildirim alırsın. Bu ekranda beklemene gerek yok."
          />
          {messages.length === 0 ? (
            <UnavailableNote>
              Henüz Steward mesajı yok. Sağ alttaki mikrofondan ilk sesli mesajını gönderebilirsin.
            </UnavailableNote>
          ) : messages.map((message) => (
            <StewardBubble
              key={message.id}
              message={message}
              nowMs={nowMs}
              busy={busy}
              speaking={speakingMessageId === message.id}
              readAloud={readAloud}
              respond={respond}
            />
          ))}
          {error === undefined ? null : (
            <View style={styles.threadError}><Banner kind="warning" message={error} /></View>
          )}
          {speechError === undefined ? null : (
            <View style={styles.threadError}>
              <Banner kind="warning" message={speechError} onDismiss={() => setSpeechError(undefined)} />
            </View>
          )}
        </ScrollView>
      )}
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

function StewardBubble({ message, nowMs, busy, speaking, readAloud, respond }: {
  message: StewardMessage;
  nowMs: number;
  busy: boolean;
  speaking: boolean;
  readAloud: (message: StewardMessage) => Promise<void>;
  respond: (messageId: string, action: "approve" | "decline" | "accept") => Promise<void>;
}) {
  const mine = message.author === "user";
  return (
    <View style={[styles.bubbleWrap, mine ? styles.bubbleWrapMine : null]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : null]}>
        <Text style={[styles.bubbleText, mine ? styles.bubbleTextMine : null]}>{message.content}</Text>
        <Text style={styles.bubbleMeta}>
          {message.inputMode === "voice" ? "sesli mesaj · " : message.kind === "reply" ? "" : `${message.kind} · `}
          {nowMs === 0 ? "" : relativeAge(message.createdAtEpochMs, nowMs)}
        </Text>
      </View>
      {message.author === "steward" ? (
        <View style={styles.bubbleActions}>
          <BubbleAction
            label={speaking ? "Durdur" : "Sesli oku"}
            busy={false}
            onPress={() => { void readAloud(message); }}
          />
          {message.kind === "proposal" ? (
            <>
              <BubbleAction label="Approve" busy={busy} onPress={() => void respond(message.id, "approve")} accent />
              <BubbleAction label="Decline" busy={busy} onPress={() => void respond(message.id, "decline")} />
            </>
          ) : null}
          {message.kind === "suggestion" ? (
            <BubbleAction label="Accept" busy={busy} onPress={() => void respond(message.id, "accept")} accent />
          ) : null}
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

async function configureVoicePlaybackAudio(): Promise<void> {
  await configureStewardAudioSession(() => setAudioModeAsync({
    allowsRecording: false,
    allowsBackgroundRecording: false,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
  }));
}

const styles = StyleSheet.create({
  centre: { flex: 1, justifyContent: "center", padding: space.screen },
  thread: { gap: space.sm, padding: space.screen, paddingBottom: 112 },
  threadError: { paddingTop: space.sm },
  bubbleWrap: { alignItems: "flex-start", gap: 6, maxWidth: "92%" },
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
  bubbleActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
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
});
