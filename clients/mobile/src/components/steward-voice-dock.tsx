import {
  AudioModule,
  RecordingPresets,
  type RecordingStatus,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useGlobalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { StewardMessage } from "@/application/ports";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import {
  createVoiceRecordingCompletion,
  startVoiceRecording,
  stewardReplyAfter,
  updateVoiceSilence,
  voiceProjectId,
  type VoiceRecordingCompletion,
  type VoiceRouteParams,
  type VoiceSilenceState,
} from "@/presentation/steward-voice-presentation";
import { useAppLifecycle } from "@/platform/app-lifecycle";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

type VoicePhase = "idle" | "permission" | "listening" | "transcribing" | "waiting" | "speaking" | "error";

const REPLY_POLL_MS = 1_250;
const REPLY_TIMEOUT_MS = 90_000;
const RECORDING_FINALIZE_TIMEOUT_MS = 2_000;
const STEWARD_RECORDING = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  isMeteringEnabled: true,
};
const STEWARD_RECORDING_MEDIA_TYPE = Platform.OS === "web" ? "audio/webm" : "audio/m4a";

/// A global, deliberately small microphone. It expands in place instead of
/// navigating away from the user's current Task/Session, then runs one bounded
/// record → Steward → speech loop at a time.
export function StewardVoiceDock() {
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const overview = useOverview();
  const lifecycle = useAppLifecycle();
  const insets = useSafeAreaInsets();
  const routeParams = useGlobalSearchParams() as VoiceRouteParams;
  const routeProjectId = voiceProjectId(routeParams, overview.overview);
  const projects = overview.overview?.projects ?? [];

  const [expanded, setExpanded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(routeProjectId);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const [heard, setHeard] = useState<string | undefined>(undefined);
  const [reply, setReply] = useState<StewardMessage | undefined>(undefined);

  const recordingCompletionRef = useRef<VoiceRecordingCompletion | undefined>(undefined);
  const recorder = useAudioRecorder(
    STEWARD_RECORDING,
    (status: RecordingStatus) => recordingCompletionRef.current?.receive(status),
  );
  const recorderState = useAudioRecorderState(recorder, 100);
  const player = useAudioPlayer(null, { updateInterval: 100 });
  const playerStatus = useAudioPlayerStatus(player);

  const phaseRef = useRef<VoicePhase>("idle");
  const expandedRef = useRef(false);
  const conversationRef = useRef(0);
  const stoppingRef = useRef(false);
  const silenceRef = useRef<VoiceSilenceState>({ heardVoice: false, lastVoiceAtMs: 0 });
  const speechFileRef = useRef<File | undefined>(undefined);
  const speakingConversationRef = useRef(0);
  const activeTargetRef = useRef<{ connectionId: string; projectId: string } | undefined>(undefined);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0],
    [projects, selectedProjectId],
  );

  const transition = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const cleanSpeechFile = useCallback(() => {
    const file = speechFileRef.current;
    speechFileRef.current = undefined;
    if (file?.exists) {
      try { file.delete(); } catch { /* The cache can evict speech first. */ }
    }
  }, []);

  const closeConversation = useCallback(() => {
    conversationRef.current += 1;
    expandedRef.current = false;
    setExpanded(false);
    player.pause();
    cleanSpeechFile();
    if (recorder.isRecording) void recorder.stop().catch(() => undefined);
    stoppingRef.current = false;
    activeTargetRef.current = undefined;
    recordingCompletionRef.current = undefined;
    transition("idle");
    setError(undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
  }, [cleanSpeechFile, player, recorder, transition]);

  useEffect(() => {
    if (!expandedRef.current && routeProjectId !== undefined) setSelectedProjectId(routeProjectId);
  }, [routeProjectId]);

  useEffect(() => {
    if (!lifecycle.active && expandedRef.current) closeConversation();
  }, [closeConversation, lifecycle.active]);

  useEffect(() => {
    const activeConnectionId = activeTargetRef.current?.connectionId;
    if (expandedRef.current && activeConnectionId !== undefined
      && activeConnectionId !== connections.selected?.id) {
      closeConversation();
    }
  }, [closeConversation, connections.selected?.id]);

  const startListening = useCallback(async (conversation: number) => {
    if (conversation !== conversationRef.current || !expandedRef.current) return;
    const connectionId = connections.selected?.id;
    if (connectionId === undefined || selectedProject === undefined) {
      setError("Önce çevrimiçi bir Mac ve Steward projesi seç.");
      transition("error");
      return;
    }
    activeTargetRef.current = { connectionId, projectId: selectedProject.id };
    transition("permission");
    setError(undefined);
    setReply(undefined);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Mikrofon izni olmadan canlı konuşma başlatılamaz.");
      if (conversation !== conversationRef.current || !expandedRef.current) return;
      player.pause();
      cleanSpeechFile();
      await setAudioModeAsync({
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        allowsRecording: true,
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      await recorder.prepareToRecordAsync();
      if (conversation !== conversationRef.current || !expandedRef.current) return;
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
      stoppingRef.current = false;
      recordingCompletionRef.current = createVoiceRecordingCompletion();
      await startVoiceRecording(recorder);
      transition("listening");
    } catch (cause) {
      if (conversation !== conversationRef.current) return;
      setError(cause instanceof Error ? cause.message : "Mikrofon başlatılamadı.");
      transition("error");
    }
  }, [cleanSpeechFile, connections.selected?.id, player, recorder, selectedProject, transition]);

  const playReply = useCallback(async (
    conversation: number,
    connectionId: string,
    projectId: string,
    message: StewardMessage,
  ) => {
    if (runtime.kind === "mock") {
      transition("idle");
      setTimeout(() => { void startListening(conversation); }, 650);
      return;
    }
    const audio = await runtime.steward.speech(connectionId, projectId, message.sequence);
    if (conversation !== conversationRef.current || !expandedRef.current) return;
    cleanSpeechFile();
    const file = new File(Paths.cache, `termloop-steward-${conversation}-${message.sequence}.mp3`);
    file.write(audio);
    speechFileRef.current = file;
    speakingConversationRef.current = conversation;
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
      allowsRecording: false,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
    player.replace(file.uri);
    player.play();
    transition("speaking");
  }, [cleanSpeechFile, player, runtime, startListening, transition]);

  const waitForReply = useCallback(async (
    conversation: number,
    connectionId: string,
    projectId: string,
    userSequence: number,
  ): Promise<StewardMessage> => {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (Date.now() < deadline && conversation === conversationRef.current && expandedRef.current) {
      const messages = await runtime.steward.transcript(connectionId, projectId);
      const message = stewardReplyAfter(messages, userSequence);
      if (message !== undefined) return message;
      await delay(REPLY_POLL_MS);
    }
    throw new Error("Steward henüz yanıt vermedi. Biraz sonra yeniden deneyebilirsin.");
  }, [runtime]);

  const stopAndSend = useCallback(async () => {
    if (phaseRef.current !== "listening" || stoppingRef.current) return;
    stoppingRef.current = true;
    const conversation = conversationRef.current;
    const connectionId = activeTargetRef.current?.connectionId;
    const projectId = activeTargetRef.current?.projectId;
    transition("transcribing");
    try {
      const completion = recordingCompletionRef.current;
      if (completion === undefined) throw new Error("Kaydedilen ses hazırlanamadı.");
      await recorder.stop();
      const uri = await Promise.race([
        completion.finished,
        delay(RECORDING_FINALIZE_TIMEOUT_MS).then(() => {
          throw new Error("Kaydedilen ses tamamlanamadı. Yeniden dene.");
        }),
      ]);
      if (connectionId === undefined || projectId === undefined) {
        throw new Error("Kaydedilen ses hazırlanamadı.");
      }
      const bytes = await new File(uri).arrayBuffer();
      const appended = await runtime.steward.sendVoice(connectionId, projectId, {
        bytes,
        mediaType: STEWARD_RECORDING_MEDIA_TYPE,
      });
      if (conversation !== conversationRef.current || !expandedRef.current) return;
      setHeard(appended.transcript);
      transition("waiting");
      const message = await waitForReply(conversation, connectionId, projectId, appended.userSequence);
      if (conversation !== conversationRef.current || !expandedRef.current) return;
      setReply(message);
      await playReply(conversation, connectionId, projectId, message);
    } catch (cause) {
      if (conversation !== conversationRef.current) return;
      setError(cause instanceof Error ? cause.message : "Canlı konuşma tamamlanamadı.");
      transition("error");
    } finally {
      stoppingRef.current = false;
    }
  }, [playReply, recorder, runtime, transition, waitForReply]);

  useEffect(() => {
    if (phase !== "listening") return;
    const update = updateVoiceSilence(
      silenceRef.current,
      recorderState.durationMillis,
      recorderState.metering,
    );
    silenceRef.current = update.state;
    if (update.shouldStop) void stopAndSend();
  }, [phase, recorderState.durationMillis, recorderState.metering, stopAndSend]);

  useEffect(() => {
    if (phase !== "speaking" || !playerStatus.didJustFinish) return;
    const conversation = speakingConversationRef.current;
    cleanSpeechFile();
    transition("idle");
    const handle = setTimeout(() => { void startListening(conversation); }, 550);
    return () => clearTimeout(handle);
  }, [cleanSpeechFile, phase, playerStatus.didJustFinish, startListening, transition]);

  useEffect(() => closeConversation, [closeConversation]);

  const openConversation = useCallback(() => {
    if (routeProjectId !== undefined) setSelectedProjectId(routeProjectId);
    const conversation = conversationRef.current + 1;
    conversationRef.current = conversation;
    expandedRef.current = true;
    setExpanded(true);
    setHeard(undefined);
    setReply(undefined);
    setError(undefined);
    void startListening(conversation);
  }, [routeProjectId, startListening]);

  const status = voiceStatus(phase, recorderState.durationMillis);

  if (!expanded) {
    return (
      <View pointerEvents="box-none" style={[styles.overlay, { bottom: insets.bottom + 9 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Steward'la canlı konuş"
          accessibilityHint="Mikrofonu açar ve mevcut proje bağlamında canlı konuşmayı başlatır"
          onPress={openConversation}
          style={({ pressed }) => [styles.compactButton, pressed && styles.pressed]}
        >
          <MicrophoneGlyph />
          <View style={styles.liveDot} />
        </Pressable>
      </View>
    );
  }

  return (
    <View pointerEvents="box-none" style={[styles.overlay, { bottom: insets.bottom + 8 }]}>
      <View style={styles.sheet} accessibilityViewIsModal>
        <View style={styles.sheetHeader}>
          <View>
            <Text style={styles.eyebrow}>STEWARD • CANLI</Text>
            <Text style={styles.title}>Konuş, dinliyorum.</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Canlı konuşmayı kapat"
            hitSlop={10}
            onPress={closeConversation}
            style={styles.closeButton}
          >
            <Text style={styles.closeGlyph}>×</Text>
          </Pressable>
        </View>

        {projects.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.projects}>
            {projects.map((project) => (
              <Pressable
                key={project.id}
                disabled={!(["idle", "error"].includes(phase))}
                onPress={() => setSelectedProjectId(project.id)}
                style={[styles.projectChip, project.id === selectedProject?.id && styles.projectChipSelected]}
              >
                <Text style={[styles.projectLabel, project.id === selectedProject?.id && styles.projectLabelSelected]}>
                  {project.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <Text style={styles.projectName}>{selectedProject?.name ?? "Proje seçilmedi"}</Text>
        )}

        <View style={styles.turns}>
          {heard === undefined ? null : (
            <Text style={styles.turnText} numberOfLines={2}>
              <Text style={styles.turnLabel}>Sen  </Text>{heard}
            </Text>
          )}
          {reply === undefined ? null : (
            <Text style={styles.turnText} numberOfLines={3}>
              <Text style={styles.stewardLabel}>Steward  </Text>{reply.content}
            </Text>
          )}
          {error === undefined ? null : <Text style={styles.error}>{error}</Text>}
        </View>

        <View style={styles.controlRow}>
          <View style={styles.statusZone}>
            <Text style={styles.status}>{status}</Text>
            <Text style={styles.hint}>{voiceHint(phase)}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={phase === "listening" ? "Konuşmayı gönder" : "Yeniden dinle"}
            disabled={!(["listening", "idle", "error"].includes(phase))}
            onPress={() => {
              if (phase === "listening") void stopAndSend();
              else void startListening(conversationRef.current);
            }}
            style={({ pressed }) => [
              styles.voiceButton,
              phase === "listening" && styles.voiceButtonListening,
              !(["listening", "idle", "error"].includes(phase)) && styles.voiceButtonBusy,
              pressed && styles.pressed,
            ]}
          >
            {["permission", "transcribing", "waiting"].includes(phase)
              ? <ActivityIndicator color={color.onAccent} />
              : phase === "speaking"
                ? <Text style={styles.speakerGlyph}>◖))</Text>
                : <MicrophoneGlyph large active={phase === "listening"} />}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function MicrophoneGlyph({ large = false, active = false }: { large?: boolean; active?: boolean }) {
  return (
    <View style={[styles.mic, large && styles.micLarge]} accessible={false}>
      <View style={[styles.micCapsule, large && styles.micCapsuleLarge, active && styles.micCapsuleActive]} />
      <View style={[styles.micCradle, large && styles.micCradleLarge]} />
      <View style={[styles.micStem, large && styles.micStemLarge]} />
    </View>
  );
}

function voiceStatus(phase: VoicePhase, durationMs: number): string {
  if (phase === "listening") return `Dinliyorum  ${Math.max(0, Math.round(durationMs / 100) / 10).toFixed(1)} sn`;
  if (phase === "permission") return "Mikrofon hazırlanıyor";
  if (phase === "transcribing") return "Sözlerin yazıya çevriliyor";
  if (phase === "waiting") return "Steward düşünüyor";
  if (phase === "speaking") return "Steward konuşuyor";
  if (phase === "error") return "Konuşma durdu";
  return "Hazır";
}

function voiceHint(phase: VoicePhase): string {
  if (phase === "listening") return "Bitirince dokun; sessizlikte kendisi de gönderir.";
  if (phase === "speaking") return "Yanıt bitince mikrofon yeniden açılır.";
  if (phase === "error") return "Mikrofona dokunup yeniden dene.";
  return "Canlı mod açık kaldığı sürece konuşma karşılıklı sürer.";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: space.screen,
  },
  compactButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accent,
    borderWidth: 1,
    borderColor: color.accentStrong,
    shadowColor: "#000",
    shadowOpacity: 0.34,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  pressed: { opacity: 0.76, transform: [{ scale: 0.97 }] },
  liveDot: {
    position: "absolute",
    right: 3,
    top: 3,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.success,
    borderWidth: 1.5,
    borderColor: color.bgApp,
  },
  sheet: {
    width: "100%",
    maxWidth: 520,
    borderRadius: radius.sheet,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgRaised,
    padding: space.lg,
    gap: space.md,
    shadowColor: "#000",
    shadowOpacity: 0.42,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 14,
  },
  sheetHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  eyebrow: {
    color: color.success,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  title: { color: color.text, fontSize: 18, fontWeight: "700", marginTop: 2 },
  closeButton: { width: 36, height: 36, alignItems: "flex-end", justifyContent: "flex-start" },
  closeGlyph: { color: color.textSecondary, fontSize: 28, lineHeight: 29 },
  projects: { gap: space.sm },
  projectChip: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.bgApp,
  },
  projectChipSelected: { borderColor: color.accentStrong, backgroundColor: color.accentWash },
  projectLabel: { color: color.textSecondary, fontSize: 12, fontWeight: "600" },
  projectLabelSelected: { color: color.accentStrong },
  projectName: { color: color.textMuted, fontFamily: fontFamily.mono, fontSize: 11 },
  turns: { minHeight: 42, gap: space.xs },
  turnText: { color: color.textSecondary, fontSize: 13, lineHeight: 18 },
  turnLabel: { color: color.text, fontWeight: "700" },
  stewardLabel: { color: color.accentStrong, fontWeight: "700" },
  error: { color: color.danger, fontSize: 12, lineHeight: 17 },
  controlRow: { flexDirection: "row", alignItems: "center", gap: space.lg },
  statusZone: { flex: 1, minWidth: 0, gap: 2 },
  status: { color: color.text, fontFamily: fontFamily.mono, fontSize: 12, fontWeight: "700" },
  hint: { color: color.textMuted, fontSize: 11, lineHeight: 15 },
  voiceButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accent,
    borderWidth: 2,
    borderColor: color.accentStrong,
  },
  voiceButtonListening: { backgroundColor: color.danger, borderColor: "#ff9aa2" },
  voiceButtonBusy: { opacity: 0.82 },
  speakerGlyph: { color: color.onAccent, fontFamily: fontFamily.mono, fontSize: 13, fontWeight: "800" },
  mic: { width: 20, height: 25, alignItems: "center" },
  micLarge: { width: 28, height: 34 },
  micCapsule: {
    width: 9,
    height: 15,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: color.onAccent,
  },
  micCapsuleLarge: { width: 13, height: 21, borderRadius: 8, borderWidth: 2.5 },
  micCapsuleActive: { backgroundColor: color.onAccent },
  micCradle: {
    position: "absolute",
    top: 8,
    width: 16,
    height: 11,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: color.onAccent,
    borderBottomLeftRadius: 9,
    borderBottomRightRadius: 9,
  },
  micCradleLarge: { top: 11, width: 22, height: 15, borderWidth: 0, borderLeftWidth: 2.5, borderRightWidth: 2.5, borderBottomWidth: 2.5 },
  micStem: { width: 2, height: 5, backgroundColor: color.onAccent },
  micStemLarge: { width: 2.5, height: 7 },
});
