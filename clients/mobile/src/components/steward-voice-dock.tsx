import {
  AudioModule,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioStream,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useGlobalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
  appendVoiceFloatPcmBuffer,
  createVoicePcmCapture,
  createVoicePcmWav,
  updateVoiceTranscript,
  updateVoiceSilence,
  voiceProjectId,
  type VoicePcmCapture,
  type VoiceRouteParams,
  type VoiceSilenceState,
} from "@/presentation/steward-voice-presentation";
import { useAppLifecycle } from "@/platform/app-lifecycle";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

type VoicePhase = "connecting" | "idle" | "permission" | "listening" | "transcribing" | "speaking" | "error";

interface QueuedSpeech {
  message: StewardMessage;
  attempts: number;
}

const TRANSCRIPT_POLL_MS = 1_250;
const PCM_STREAM_START_TIMEOUT_MS = 2_000;
const MIN_CAPTURE_MS = 250;
const STEWARD_RECORDING_MEDIA_TYPE = "audio/wav";
const SPEECH_RETRY_LIMIT = 2;
const SPEECH_RETRY_MS = 2_000;

/// A foreground live voice room for the selected Project. While expanded it
/// follows the durable Steward transcript, speaks every new Steward message in
/// order, and keeps microphone mute independent from incoming speech.
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
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [heard, setHeard] = useState<string | undefined>(undefined);
  const [reply, setReply] = useState<StewardMessage | undefined>(undefined);
  const [recorderState, setRecorderState] = useState<{ durationMillis: number; metering: number | undefined }>({
    durationMillis: 0,
    metering: undefined,
  });

  const phaseRef = useRef<VoicePhase>("idle");
  const expandedRef = useRef(false);
  const microphoneEnabledRef = useRef(false);
  const conversationRef = useRef(0);
  const captureAttemptRef = useRef(0);
  const stoppingRef = useRef(false);
  const silenceRef = useRef<VoiceSilenceState>({ heardVoice: false, lastVoiceAtMs: 0 });
  const speechFileRef = useRef<File | undefined>(undefined);
  const speakingConversationRef = useRef(0);
  const activeTargetRef = useRef<{ connectionId: string; projectId: string } | undefined>(undefined);
  const transcriptCursorRef = useRef(0);
  const transcriptSeededRef = useRef(false);
  const speechQueueRef = useRef<QueuedSpeech[]>([]);
  const speechStartingRef = useRef(false);
  const speechRetryAtRef = useRef(0);
  const [speechQueueRevision, setSpeechQueueRevision] = useState(0);
  const pcmCaptureRef = useRef<VoicePcmCapture>(createVoicePcmCapture());
  const capturingRef = useRef(false);
  const firstBufferRef = useRef<(() => void) | undefined>(undefined);

  const { stream } = useAudioStream({
    sampleRate: 48_000,
    channels: 1,
    encoding: "float32",
    onBuffer(buffer) {
      if (!capturingRef.current) return;
      const capture = appendVoiceFloatPcmBuffer(pcmCaptureRef.current, buffer);
      pcmCaptureRef.current = capture;
      setRecorderState({ durationMillis: capture.durationMillis, metering: capture.metering });
      firstBufferRef.current?.();
      firstBufferRef.current = undefined;
    },
  });
  const player = useAudioPlayer(null, { updateInterval: 100 });
  const playerStatus = useAudioPlayerStatus(player);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0],
    [projects, selectedProjectId],
  );

  const transition = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const setMicrophone = useCallback((enabled: boolean) => {
    microphoneEnabledRef.current = enabled;
    setMicrophoneEnabled(enabled);
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
    captureAttemptRef.current += 1;
    expandedRef.current = false;
    setExpanded(false);
    setMicrophone(false);
    player.pause();
    cleanSpeechFile();
    capturingRef.current = false;
    firstBufferRef.current = undefined;
    if (stream.isStreaming) stream.stop();
    stoppingRef.current = false;
    speechStartingRef.current = false;
    speechRetryAtRef.current = 0;
    speechQueueRef.current = [];
    transcriptCursorRef.current = 0;
    transcriptSeededRef.current = false;
    setSpeechQueueRevision((revision) => revision + 1);
    activeTargetRef.current = undefined;
    transition("idle");
    setError(undefined);
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
  }, [cleanSpeechFile, player, setMicrophone, stream, transition]);

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
    if (conversation !== conversationRef.current || !expandedRef.current
      || !microphoneEnabledRef.current || phaseRef.current === "speaking"
      || phaseRef.current === "transcribing") return;
    const attempt = captureAttemptRef.current + 1;
    captureAttemptRef.current = attempt;
    const target = activeTargetRef.current;
    if (target === undefined) {
      setError("Önce çevrimiçi bir Mac ve Steward projesi seç.");
      setMicrophone(false);
      transition("error");
      return;
    }
    transition("permission");
    setError(undefined);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Mikrofon izni olmadan canlı konuşma başlatılamaz.");
      if (attempt !== captureAttemptRef.current || conversation !== conversationRef.current
        || !expandedRef.current || !microphoneEnabledRef.current) return;
      cleanSpeechFile();
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
      stoppingRef.current = false;
      pcmCaptureRef.current = createVoicePcmCapture();
      setRecorderState({ durationMillis: 0, metering: undefined });
      capturingRef.current = true;
      const firstBuffer = new Promise<void>((resolve) => { firstBufferRef.current = resolve; });
      await stream.start();
      await Promise.race([
        firstBuffer,
        delay(PCM_STREAM_START_TIMEOUT_MS).then(() => {
          throw new Error("Mikrofondan ses verisi alınamadı. Yeniden dene.");
        }),
      ]);
      if (attempt !== captureAttemptRef.current || conversation !== conversationRef.current
        || !expandedRef.current || !microphoneEnabledRef.current) {
        capturingRef.current = false;
        if (stream.isStreaming) stream.stop();
        if (conversation === conversationRef.current && expandedRef.current) transition("idle");
        return;
      }
      transition("listening");
    } catch (cause) {
      capturingRef.current = false;
      firstBufferRef.current = undefined;
      if (stream.isStreaming) stream.stop();
      if (attempt !== captureAttemptRef.current || conversation !== conversationRef.current) return;
      setMicrophone(false);
      setError(cause instanceof Error ? cause.message : "Mikrofon başlatılamadı.");
      transition("error");
    }
  }, [cleanSpeechFile, setMicrophone, stream, transition]);

  const playNextSpeech = useCallback(async (conversation: number) => {
    if (speechStartingRef.current || conversation !== conversationRef.current || !expandedRef.current) return;
    if (["connecting", "permission", "transcribing", "speaking"].includes(phaseRef.current)) return;
    if (phaseRef.current === "listening" && silenceRef.current.heardVoice) return;
    const retryDelay = speechRetryAtRef.current - Date.now();
    if (retryDelay > 0) {
      setTimeout(() => {
        if (conversation === conversationRef.current && expandedRef.current) {
          setSpeechQueueRevision((revision) => revision + 1);
        }
      }, retryDelay);
      return;
    }
    const queued = speechQueueRef.current.shift();
    if (queued === undefined) return;
    speechRetryAtRef.current = 0;
    speechStartingRef.current = true;
    setSpeechQueueRevision((revision) => revision + 1);
    const target = activeTargetRef.current;
    if (phaseRef.current === "listening") {
      captureAttemptRef.current += 1;
      capturingRef.current = false;
      firstBufferRef.current = undefined;
      if (stream.isStreaming) stream.stop();
      pcmCaptureRef.current = createVoicePcmCapture();
      setRecorderState({ durationMillis: 0, metering: undefined });
    }
    setReply(queued.message);
    setError(undefined);
    transition("speaking");
    try {
      if (target === undefined) throw new Error("Steward ses hedefi artık kullanılamıyor.");
      if (runtime.kind === "mock") {
        await delay(500);
      } else {
        const audio = await runtime.steward.speech(target.connectionId, target.projectId, queued.message.sequence);
        if (conversation !== conversationRef.current || !expandedRef.current) return;
        cleanSpeechFile();
        const file = new File(Paths.cache, `termloop-steward-${conversation}-${queued.message.sequence}.mp3`);
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
        return;
      }
    } catch (cause) {
      if (conversation !== conversationRef.current) return;
      if (queued.attempts < SPEECH_RETRY_LIMIT) {
        speechQueueRef.current.unshift({ ...queued, attempts: queued.attempts + 1 });
        speechRetryAtRef.current = Date.now() + SPEECH_RETRY_MS;
      } else {
        speechRetryAtRef.current = 0;
      }
      setError(cause instanceof Error ? cause.message : "Steward mesajı seslendirilemedi.");
    } finally {
      speechStartingRef.current = false;
    }
    if (conversation !== conversationRef.current || !expandedRef.current) return;
    cleanSpeechFile();
    transition("idle");
    setSpeechQueueRevision((revision) => revision + 1);
    if (speechQueueRef.current.length === 0 && microphoneEnabledRef.current) {
      setTimeout(() => { void startListening(conversation); }, 350);
    }
  }, [cleanSpeechFile, player, runtime, startListening, stream, transition]);

  const stopAndSend = useCallback(async () => {
    if (phaseRef.current !== "listening" || stoppingRef.current) return;
    stoppingRef.current = true;
    const conversation = conversationRef.current;
    const connectionId = activeTargetRef.current?.connectionId;
    const projectId = activeTargetRef.current?.projectId;
    transition("transcribing");
    try {
      capturingRef.current = false;
      stream.stop();
      const capture = pcmCaptureRef.current;
      if (capture.durationMillis < MIN_CAPTURE_MS) {
        throw new Error("Yeterli ses kaydedilemedi. Yeniden konuş.");
      }
      if (connectionId === undefined || projectId === undefined) {
        throw new Error("Kaydedilen ses hazırlanamadı.");
      }
      const bytes = createVoicePcmWav(capture);
      const appended = await runtime.steward.sendVoice(connectionId, projectId, {
        bytes,
        mediaType: STEWARD_RECORDING_MEDIA_TYPE,
      });
      if (conversation !== conversationRef.current || !expandedRef.current) return;
      setHeard(appended.transcript);
      setError(undefined);
    } catch (cause) {
      if (conversation !== conversationRef.current) return;
      setError(cause instanceof Error ? cause.message : "Canlı konuşma tamamlanamadı.");
    } finally {
      stoppingRef.current = false;
      if (conversation === conversationRef.current && expandedRef.current) {
        transition("idle");
        setSpeechQueueRevision((revision) => revision + 1);
        if (speechQueueRef.current.length === 0 && microphoneEnabledRef.current) {
          setTimeout(() => {
            if (phaseRef.current === "idle" && speechQueueRef.current.length === 0) {
              void startListening(conversation);
            }
          }, 350);
        }
      }
    }
  }, [runtime, startListening, stream, transition]);

  useEffect(() => {
    if (phase !== "listening") return;
    const update = updateVoiceSilence(
      silenceRef.current,
      recorderState.durationMillis,
      recorderState.metering,
    );
    silenceRef.current = update.state;
    if (update.shouldStop) void stopAndSend();
    if (update.shouldReset) {
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
      pcmCaptureRef.current = createVoicePcmCapture();
      setRecorderState({ durationMillis: 0, metering: undefined });
    }
  }, [phase, recorderState.durationMillis, recorderState.metering, stopAndSend]);

  const beginLiveConversation = useCallback(async (
    conversation: number,
    target: { connectionId: string; projectId: string },
  ) => {
    transition("connecting");
    try {
      const messages = await runtime.steward.transcript(target.connectionId, target.projectId);
      if (conversation !== conversationRef.current || !expandedRef.current) return;
      transcriptCursorRef.current = updateVoiceTranscript(messages, 0).cursor;
      transcriptSeededRef.current = true;
      transition("idle");
      if (microphoneEnabledRef.current) void startListening(conversation);
    } catch (cause) {
      if (conversation !== conversationRef.current) return;
      setMicrophone(false);
      setError(cause instanceof Error ? cause.message : "Canlı Steward akışı başlatılamadı.");
      transition("error");
    }
  }, [runtime, setMicrophone, startListening, transition]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      const target = activeTargetRef.current;
      if (polling || target === undefined || !transcriptSeededRef.current) return;
      polling = true;
      try {
        const messages = await runtime.steward.transcript(target.connectionId, target.projectId);
        if (cancelled || target !== activeTargetRef.current || !expandedRef.current) return;
        const update = updateVoiceTranscript(messages, transcriptCursorRef.current);
        transcriptCursorRef.current = update.cursor;
        if (update.stewardMessages.length > 0) {
          speechQueueRef.current.push(...update.stewardMessages.map((message) => ({ message, attempts: 0 })));
          setSpeechQueueRevision((revision) => revision + 1);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Yeni Steward mesajları alınamadı.");
        }
      } finally {
        polling = false;
      }
    };
    const handle = setInterval(() => { void poll(); }, TRANSCRIPT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [expanded, runtime, selectedProject?.id]);

  useEffect(() => {
    if (!expanded || speechQueueRef.current.length === 0 || speechStartingRef.current) return;
    if (["connecting", "permission", "transcribing", "speaking"].includes(phase)) return;
    if (phase === "listening" && silenceRef.current.heardVoice) return;
    void playNextSpeech(conversationRef.current);
  }, [expanded, phase, playNextSpeech, speechQueueRevision]);

  useEffect(() => {
    if (phase !== "speaking" || !playerStatus.didJustFinish) return;
    const conversation = speakingConversationRef.current;
    cleanSpeechFile();
    transition("idle");
    setSpeechQueueRevision((revision) => revision + 1);
    const handle = setTimeout(() => {
      if (speechQueueRef.current.length === 0 && microphoneEnabledRef.current) {
        void startListening(conversation);
      }
    }, 550);
    return () => clearTimeout(handle);
  }, [cleanSpeechFile, phase, playerStatus.didJustFinish, startListening, transition]);

  useEffect(() => closeConversation, [closeConversation]);

  const resetLiveTarget = useCallback((projectId: string) => {
    const connectionId = connections.selected?.id;
    if (connectionId === undefined) return;
    const conversation = conversationRef.current + 1;
    conversationRef.current = conversation;
    captureAttemptRef.current += 1;
    cleanSpeechFile();
    capturingRef.current = false;
    firstBufferRef.current = undefined;
    if (stream.isStreaming) stream.stop();
    speechStartingRef.current = false;
    speechRetryAtRef.current = 0;
    speechQueueRef.current = [];
    transcriptCursorRef.current = 0;
    transcriptSeededRef.current = false;
    activeTargetRef.current = { connectionId, projectId };
    setSelectedProjectId(projectId);
    setHeard(undefined);
    setReply(undefined);
    setError(undefined);
    setSpeechQueueRevision((revision) => revision + 1);
    void beginLiveConversation(conversation, { connectionId, projectId });
  }, [beginLiveConversation, cleanSpeechFile, connections.selected?.id, stream]);

  const openConversation = useCallback(() => {
    const project = projects.find((candidate) => candidate.id === routeProjectId) ?? selectedProject;
    const connectionId = connections.selected?.id;
    const conversation = conversationRef.current + 1;
    conversationRef.current = conversation;
    expandedRef.current = true;
    setExpanded(true);
    setMicrophone(true);
    setHeard(undefined);
    setReply(undefined);
    setError(undefined);
    speechQueueRef.current = [];
    transcriptCursorRef.current = 0;
    transcriptSeededRef.current = false;
    setSpeechQueueRevision((revision) => revision + 1);
    if (project === undefined || connectionId === undefined) {
      setMicrophone(false);
      setError("Önce çevrimiçi bir Mac ve Steward projesi seç.");
      transition("error");
      return;
    }
    setSelectedProjectId(project.id);
    const target = { connectionId, projectId: project.id };
    activeTargetRef.current = target;
    void beginLiveConversation(conversation, target);
  }, [beginLiveConversation, connections.selected?.id, projects, routeProjectId, selectedProject, setMicrophone, transition]);

  const toggleMicrophone = useCallback(() => {
    if (microphoneEnabledRef.current) {
      setMicrophone(false);
      captureAttemptRef.current += 1;
      capturingRef.current = false;
      firstBufferRef.current = undefined;
      if (stream.isStreaming) stream.stop();
      pcmCaptureRef.current = createVoicePcmCapture();
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
      setRecorderState({ durationMillis: 0, metering: undefined });
      if (phaseRef.current === "listening" || phaseRef.current === "permission") transition("idle");
      if (phaseRef.current !== "speaking") {
        void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
      }
      return;
    }
    setMicrophone(true);
    setError(undefined);
    if (phaseRef.current === "idle" || phaseRef.current === "error") {
      void startListening(conversationRef.current);
    }
  }, [setMicrophone, startListening, stream, transition]);

  const status = voiceStatus(phase, recorderState.durationMillis, microphoneEnabled);

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
            <Text style={styles.title}>Canlı konuşma açık.</Text>
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
                onPress={() => resetLiveTarget(project.id)}
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
            <Text style={styles.hint}>{voiceHint(phase, microphoneEnabled)}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={microphoneEnabled ? "Mikrofonu kapat" : "Mikrofonu aç"}
            accessibilityHint="Canlı Steward oturumundaki mikrofonu açar veya sessize alır"
            onPress={toggleMicrophone}
            style={({ pressed }) => [
              styles.voiceButton,
              microphoneEnabled ? styles.voiceButtonListening : styles.voiceButtonMuted,
              ["connecting", "permission", "transcribing"].includes(phase) && styles.voiceButtonBusy,
              pressed && styles.pressed,
            ]}
          >
            <MicrophoneGlyph large active={microphoneEnabled} muted={!microphoneEnabled} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function MicrophoneGlyph({
  large = false,
  active = false,
  muted = false,
}: {
  large?: boolean;
  active?: boolean;
  muted?: boolean;
}) {
  return (
    <View style={[styles.mic, large && styles.micLarge]} accessible={false}>
      <View style={[styles.micCapsule, large && styles.micCapsuleLarge, active && styles.micCapsuleActive]} />
      <View style={[styles.micCradle, large && styles.micCradleLarge]} />
      <View style={[styles.micStem, large && styles.micStemLarge]} />
      {muted ? <View style={[styles.micMutedSlash, large && styles.micMutedSlashLarge]} /> : null}
    </View>
  );
}

function voiceStatus(phase: VoicePhase, durationMs: number, microphoneEnabled: boolean): string {
  if (phase === "listening") return `Dinliyorum  ${Math.max(0, Math.round(durationMs / 100) / 10).toFixed(1)} sn`;
  if (phase === "connecting") return "Canlı akış bağlanıyor";
  if (phase === "permission") return "Mikrofon hazırlanıyor";
  if (phase === "transcribing") return "Sözlerin yazıya çevriliyor";
  if (phase === "speaking") return "Steward konuşuyor";
  if (phase === "error") return "Canlı akışta sorun var";
  return microphoneEnabled ? "Mikrofon açık" : "Mikrofon kapalı";
}

function voiceHint(phase: VoicePhase, microphoneEnabled: boolean): string {
  if (phase === "listening") return "Konuşman sessizlikte otomatik gönderilir; dokunursan mikrofon kapanır.";
  if (phase === "speaking") return microphoneEnabled
    ? "Yanıt bitince mikrofon yeniden dinlemeye başlar."
    : "Mikrofon kapalı; yeni Steward mesajları yine okunur.";
  if (phase === "transcribing") return "Bu tur gönderiliyor; mikrofon durumunu istediğin an değiştirebilirsin.";
  if (phase === "error") return "Mikrofonu yeniden açabilir veya canlı akışı açık bırakabilirsin.";
  if (!microphoneEnabled) return "Gelen Steward mesajları okunur; konuşmak için mikrofonu aç.";
  return "Yeni Steward mesajları sırayla okunur.";
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
  voiceButtonMuted: { backgroundColor: color.bgApp, borderColor: color.borderStrong },
  voiceButtonBusy: { opacity: 0.82 },
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
  micMutedSlash: {
    position: "absolute",
    top: 1,
    width: 2,
    height: 25,
    borderRadius: 1,
    backgroundColor: color.danger,
    transform: [{ rotate: "-42deg" }],
  },
  micMutedSlashLarge: { top: 0, height: 34, width: 3, borderRadius: 1.5 },
});
