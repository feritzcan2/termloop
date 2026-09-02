import {
  AudioModule,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio";
import { useGlobalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { StewardVoiceControls } from "@/components/steward-voice-controls";
import { useMobileRuntime } from "@/composition/runtime-context";
import { useConnections } from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import {
  enabledVoiceTargets,
  switchableVoiceTarget,
  type VoiceProjectTarget,
} from "@/presentation/steward-voice-project-selection";
import {
  appendVoiceFloatPcmBuffer,
  createVoicePcmCapture,
  createVoicePcmWav,
  updateVoiceSilence,
  voiceProjectId,
  type VoicePcmCapture,
  type VoicePhase,
  type VoiceRouteParams,
  type VoiceSilenceState,
} from "@/presentation/steward-voice-presentation";
import {
  configureStewardAudioSession,
  stewardVoiceAudioErrorMessage,
} from "@/platform/steward-voice-audio";
import { stewardLiveActivity } from "@/platform/steward-live-activity";
import { space } from "@/theme/tokens";

const PCM_STREAM_START_TIMEOUT_MS = 2_000;
const MIN_CAPTURE_MS = 250;
const STEWARD_RECORDING_MEDIA_TYPE = "audio/wav";
const SENT_CONFIRMATION_MS = 1_800;

/// A bounded voice-message composer for Steward.
///
/// Recording ends in one transcript review and one append. The phone deliberately
/// does not keep a live conversation, poll for a reply, speak replies, or reconnect
/// an open voice session. The gateway's existing Steward push notification owns the
/// later response, so sending never asks the user to wait on this screen.
export function StewardVoiceDock() {
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const overview = useOverview();
  const insets = useSafeAreaInsets();
  const routeParams = useGlobalSearchParams() as VoiceRouteParams;
  const targets = useMemo(() => enabledVoiceTargets(connections.connections.map((connection) => ({
    connectionId: connection.id,
    connectionName: connection.name,
    overview: overview.byConnection.get(connection.id)?.overview,
  }))), [connections.connections, overview.byConnection]);
  const routeScoped = hasVoiceRouteScope(routeParams);
  const routeConnectionId = routeValue(routeParams.connectionId) ?? connections.selectedId;
  const routeOverview = routeConnectionId === undefined
    ? undefined
    : overview.byConnection.get(routeConnectionId)?.overview;
  const routeProjectId = voiceProjectId(routeParams, routeOverview);
  const routeTarget = routeConnectionId === undefined || routeProjectId === undefined
    ? undefined
    : targets.find((target) => (
      target.connectionId === routeConnectionId && target.projectId === routeProjectId
    ));

  const [active, setActive] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState<string | undefined>(undefined);
  const [activeTargetId, setActiveTargetId] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<VoicePhase>("ready");
  const [error, setError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [editingDraft, setEditingDraft] = useState(false);
  const [recorderState, setRecorderState] = useState<{
    durationMillis: number;
    metering: number | undefined;
  }>({ durationMillis: 0, metering: undefined });

  const activeRef = useRef(false);
  const activeTargetRef = useRef<VoiceProjectTarget | undefined>(undefined);
  const phaseRef = useRef<VoicePhase>("ready");
  const captureAttemptRef = useRef(0);
  const capturingRef = useRef(false);
  const stoppingRef = useRef(false);
  const firstBufferRef = useRef<(() => void) | undefined>(undefined);
  const pcmCaptureRef = useRef<VoicePcmCapture>(createVoicePcmCapture());
  const silenceRef = useRef<VoiceSilenceState>({ heardVoice: false, lastVoiceAtMs: 0 });
  const draftRef = useRef("");
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
  const streamRef = useRef(stream);
  streamRef.current = stream;

  const selectedTarget = routeScoped
    ? routeTarget
    : targets.find((target) => target.id === selectedTargetId) ?? routeTarget ?? targets[0];
  const activeTarget = targets.find((target) => target.id === activeTargetId);
  const displayedTarget = active ? activeTarget : selectedTarget;

  const transition = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearSentTimer = useCallback(() => {
    if (sentTimerRef.current !== undefined) clearTimeout(sentTimerRef.current);
    sentTimerRef.current = undefined;
  }, []);

  const stopCapture = useCallback(() => {
    captureAttemptRef.current += 1;
    capturingRef.current = false;
    firstBufferRef.current = undefined;
    if (stream.isStreaming) stream.stop();
    pcmCaptureRef.current = createVoicePcmCapture();
    silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
    setRecorderState({ durationMillis: 0, metering: undefined });
  }, [stream]);

  const closeComposer = useCallback(() => {
    clearSentTimer();
    activeRef.current = false;
    activeTargetRef.current = undefined;
    setActive(false);
    setActiveTargetId(undefined);
    stopCapture();
    stoppingRef.current = false;
    draftRef.current = "";
    setDraft("");
    setEditingDraft(false);
    setError(undefined);
    transition("ready");
    void deactivateVoiceAudio().catch(() => undefined);
  }, [clearSentTimer, stopCapture, transition]);

  const openComposer = useCallback(() => {
    if (selectedTarget === undefined) return;
    clearSentTimer();
    activeRef.current = true;
    activeTargetRef.current = selectedTarget;
    setActive(true);
    setActiveTargetId(selectedTarget.id);
    setSelectedTargetId(selectedTarget.id);
    setError(undefined);
    setDraft("");
    draftRef.current = "";
    setEditingDraft(false);
    transition("ready");
  }, [clearSentTimer, selectedTarget, transition]);

  const startRecording = useCallback(async () => {
    if (!activeRef.current || !["ready", "error"].includes(phaseRef.current)) return;
    const target = activeTargetRef.current;
    if (target === undefined) {
      setError("Önce çevrimiçi bir Mac ve Steward projesi seç.");
      transition("error");
      return;
    }
    const attempt = captureAttemptRef.current + 1;
    captureAttemptRef.current = attempt;
    transition("permission");
    setError(undefined);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Mikrofon izni olmadan sesli mesaj kaydedilemez.");
      if (attempt !== captureAttemptRef.current || !activeRef.current) return;
      await configureVoiceRecordingAudio();
      if (attempt !== captureAttemptRef.current || !activeRef.current) return;
      pcmCaptureRef.current = createVoicePcmCapture();
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
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
      if (attempt !== captureAttemptRef.current || !activeRef.current) {
        if (attempt === captureAttemptRef.current) stopCapture();
        return;
      }
      transition("listening");
    } catch (cause) {
      if (attempt !== captureAttemptRef.current) return;
      stopCapture();
      setError(stewardVoiceAudioErrorMessage(cause, "Mikrofon başlatılamadı."));
      transition("error");
    }
  }, [stopCapture, stream, transition]);

  const stopAndPreview = useCallback(async () => {
    if (phaseRef.current !== "listening" || stoppingRef.current) return;
    stoppingRef.current = true;
    const target = activeTargetRef.current;
    const targetId = target?.id;
    const capture = pcmCaptureRef.current;
    captureAttemptRef.current += 1;
    capturingRef.current = false;
    firstBufferRef.current = undefined;
    if (stream.isStreaming) stream.stop();
    transition("transcribing");
    try {
      if (capture.durationMillis < MIN_CAPTURE_MS) throw new Error("Yeterli ses kaydedilemedi. Yeniden konuş.");
      if (target === undefined) throw new Error("Kaydedilen ses hazırlanamadı.");
      const transcript = await runtime.steward.transcribeVoice(target.connectionId, {
        bytes: createVoicePcmWav(capture),
        mediaType: STEWARD_RECORDING_MEDIA_TYPE,
      });
      if (!activeRef.current || activeTargetRef.current?.id !== targetId) return;
      draftRef.current = transcript;
      setDraft(transcript);
      setEditingDraft(false);
      setError(undefined);
      transition("reviewing");
    } catch (cause) {
      if (!activeRef.current) return;
      setError(describe(cause, "Konuşma yazıya çevrilemedi."));
      transition("error");
    } finally {
      stoppingRef.current = false;
      pcmCaptureRef.current = createVoicePcmCapture();
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
      setRecorderState({ durationMillis: 0, metering: undefined });
      void deactivateVoiceAudio().catch(() => undefined);
    }
  }, [runtime, stream, transition]);

  useEffect(() => {
    if (phase !== "listening") return;
    const update = updateVoiceSilence(silenceRef.current, recorderState.durationMillis, recorderState.metering);
    silenceRef.current = update.state;
    if (update.shouldStop) void stopAndPreview();
    if (update.shouldReset) {
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
      pcmCaptureRef.current = createVoicePcmCapture();
      setRecorderState({ durationMillis: 0, metering: undefined });
    }
  }, [phase, recorderState.durationMillis, recorderState.metering, stopAndPreview]);

  const selectProject = useCallback((targetId: string) => {
    const current = activeTargetRef.current;
    const target = switchableVoiceTarget(targets, current?.id, targetId, phaseRef.current);
    if (target === undefined) return;
    activeTargetRef.current = target;
    setActiveTargetId(target.id);
    setSelectedTargetId(target.id);
    setError(undefined);
    setDraft("");
    draftRef.current = "";
    setEditingDraft(false);
    transition("ready");
  }, [targets, transition]);

  const changeDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
  }, []);

  const commitDraft = useCallback(async () => {
    if (phaseRef.current !== "reviewing") return;
    const target = activeTargetRef.current;
    const targetId = target?.id;
    const content = draftRef.current.trim();
    if (target === undefined || content.length === 0) return;
    transition("sending");
    setEditingDraft(false);
    setError(undefined);
    try {
      const appended = await runtime.steward.commitVoice(target.connectionId, target.projectId, content);
      if (!activeRef.current || activeTargetRef.current?.id !== targetId) return;
      draftRef.current = appended.transcript;
      setDraft(appended.transcript);
      transition("sent");
      sentTimerRef.current = setTimeout(closeComposer, SENT_CONFIRMATION_MS);
    } catch (cause) {
      if (!activeRef.current) return;
      setError(describe(cause, "Sesli mesaj gönderilemedi."));
      setEditingDraft(true);
      transition("reviewing");
    }
  }, [closeComposer, runtime, transition]);

  const toggleRecording = useCallback(() => {
    if (phaseRef.current === "listening") {
      void stopAndPreview();
      return;
    }
    if (["ready", "error"].includes(phaseRef.current)) void startRecording();
  }, [startRecording, stopAndPreview]);

  useEffect(() => {
    if (!activeRef.current && routeTarget !== undefined) setSelectedTargetId(routeTarget.id);
  }, [routeTarget]);

  useEffect(() => {
    const target = activeTargetRef.current;
    if (activeRef.current && target !== undefined
      && !targets.some((candidate) => candidate.id === target.id)) closeComposer();
  }, [closeComposer, targets]);

  useEffect(() => () => {
    clearSentTimer();
    if (streamRef.current.isStreaming) streamRef.current.stop();
    void deactivateVoiceAudio().catch(() => undefined);
  }, [clearSentTimer]);

  // An OTA can replace the former live-conversation UI while its native Live
  // Activity is still present. End that one stale activity once; this composer
  // never starts another.
  useEffect(() => {
    void stewardLiveActivity.end().catch(() => undefined);
  }, []);

  const voiceAvailable = active ? activeTarget !== undefined : selectedTarget !== undefined;
  if (!voiceAvailable) return null;

  return (
    <KeyboardAvoidingView
      behavior="position"
      contentContainerStyle={styles.overlayContent}
      pointerEvents="box-none"
      style={[styles.overlay, { bottom: insets.bottom + 8 }]}
    >
      <StewardVoiceControls
        active={active}
        draft={draft}
        durationMillis={recorderState.durationMillis}
        editingDraft={editingDraft}
        error={error}
        onBeginCorrection={() => setEditingDraft(true)}
        onClose={closeComposer}
        onCommitDraft={() => { void commitDraft(); }}
        onDraftChange={changeDraft}
        onSelectProject={selectProject}
        onStart={openComposer}
        onToggleRecording={toggleRecording}
        phase={phase}
        projects={targets.map((target) => ({
          id: target.id,
          name: target.projectName,
          connectionName: target.connectionName,
        }))}
        projectName={displayedTarget?.projectName ?? "Steward"}
        selectedProjectId={displayedTarget?.id}
      />
    </KeyboardAvoidingView>
  );
}

function hasVoiceRouteScope(params: VoiceRouteParams): boolean {
  return [params.projectId, params.taskId, params.sessionId].some((value) => (
    value !== undefined && value.length > 0
  ));
}

function routeValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

async function configureVoiceRecordingAudio(): Promise<void> {
  await configureStewardAudioSession(() => setAudioModeAsync({
    allowsRecording: true,
    allowsBackgroundRecording: false,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
  }));
}

async function deactivateVoiceAudio(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    allowsBackgroundRecording: false,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
  });
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
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
  overlayContent: { width: "100%", alignItems: "center" },
});
