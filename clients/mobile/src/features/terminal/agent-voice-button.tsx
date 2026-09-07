import { AudioModule, setAudioModeAsync, useAudioStream } from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { MicrophoneGlyph } from "@/components/microphone-glyph";
import { useMobileRuntime } from "@/composition/runtime-context";
import {
  agentComposerVoiceStatus,
  type AgentComposerVoicePhase,
} from "@/presentation/agent-composer-voice-presentation";
import {
  appendVoiceFloatPcmBuffer,
  createVoicePcmCapture,
  createVoicePcmWav,
  updateVoiceSilence,
  type VoicePcmCapture,
  type VoiceSilenceState,
} from "@/presentation/steward-voice-presentation";
import {
  configureStewardAudioSession,
  stewardVoiceAudioErrorMessage,
} from "@/platform/steward-voice-audio";
import { color, geometry, radius, space } from "@/theme/tokens";
import { fontFamily } from "@/theme/typography";

const PCM_STREAM_START_TIMEOUT_MS = 2_000;
const MIN_CAPTURE_MS = 250;
const RECORDING_MEDIA_TYPE = "audio/wav";

export function AgentVoiceButton({
  connectionId,
  disabled,
  sessionScope,
  onBusyChange,
  onTranscript,
}: {
  connectionId: string | undefined;
  disabled: boolean;
  sessionScope: string;
  onBusyChange: (busy: boolean) => void;
  onTranscript: (transcript: string) => void;
}) {
  const runtime = useMobileRuntime();
  const [phase, setPhase] = useState<AgentComposerVoicePhase>("ready");
  const [error, setError] = useState<string | undefined>(undefined);
  const [recorderState, setRecorderState] = useState<{
    durationMillis: number;
    metering: number | undefined;
  }>({ durationMillis: 0, metering: undefined });

  const phaseRef = useRef<AgentComposerVoicePhase>("ready");
  const scopeRef = useRef(sessionScope);
  const captureAttemptRef = useRef(0);
  const capturingRef = useRef(false);
  const stoppingRef = useRef(false);
  const firstBufferRef = useRef<(() => void) | undefined>(undefined);
  const pcmCaptureRef = useRef<VoicePcmCapture>(createVoicePcmCapture());
  const silenceRef = useRef<VoiceSilenceState>({ heardVoice: false, lastVoiceAtMs: 0 });
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

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

  const transition = useCallback((next: AgentComposerVoicePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const clearCapture = useCallback(() => {
    captureAttemptRef.current += 1;
    capturingRef.current = false;
    firstBufferRef.current = undefined;
    if (stream.isStreaming) stream.stop();
    pcmCaptureRef.current = createVoicePcmCapture();
    silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
    setRecorderState({ durationMillis: 0, metering: undefined });
  }, [stream]);

  const reset = useCallback(() => {
    clearCapture();
    stoppingRef.current = false;
    setError(undefined);
    transition("ready");
    void deactivateVoiceAudio().catch(() => undefined);
  }, [clearCapture, transition]);

  const startRecording = useCallback(async () => {
    if (disabled || connectionId === undefined || !["ready", "error"].includes(phaseRef.current)) return;
    const attempt = captureAttemptRef.current + 1;
    const scope = scopeRef.current;
    captureAttemptRef.current = attempt;
    transition("permission");
    setError(undefined);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Mikrofon izni olmadan sesli mesaj kaydedilemez.");
      if (attempt !== captureAttemptRef.current || scope !== scopeRef.current) return;
      await configureVoiceRecordingAudio();
      if (attempt !== captureAttemptRef.current || scope !== scopeRef.current) return;
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
      if (attempt !== captureAttemptRef.current || scope !== scopeRef.current) {
        if (attempt === captureAttemptRef.current) clearCapture();
        return;
      }
      transition("listening");
    } catch (cause) {
      if (attempt !== captureAttemptRef.current) return;
      clearCapture();
      setError(stewardVoiceAudioErrorMessage(cause, "Mikrofon başlatılamadı."));
      transition("error");
    }
  }, [clearCapture, connectionId, disabled, stream, transition]);

  const stopAndTranscribe = useCallback(async () => {
    if (phaseRef.current !== "listening" || stoppingRef.current) return;
    stoppingRef.current = true;
    const targetConnectionId = connectionId;
    const scope = scopeRef.current;
    const capture = pcmCaptureRef.current;
    const attempt = captureAttemptRef.current + 1;
    captureAttemptRef.current = attempt;
    capturingRef.current = false;
    firstBufferRef.current = undefined;
    if (stream.isStreaming) stream.stop();
    transition("transcribing");
    try {
      if (capture.durationMillis < MIN_CAPTURE_MS) throw new Error("Yeterli ses kaydedilemedi. Yeniden konuş.");
      if (targetConnectionId === undefined) throw new Error("Mac bağlantısı bulunamadı.");
      const transcript = await runtime.steward.transcribeVoice(targetConnectionId, {
        bytes: createVoicePcmWav(capture),
        mediaType: RECORDING_MEDIA_TYPE,
      });
      if (attempt !== captureAttemptRef.current || scope !== scopeRef.current) return;
      onTranscriptRef.current(transcript);
      setError(undefined);
      transition("ready");
    } catch (cause) {
      if (attempt !== captureAttemptRef.current || scope !== scopeRef.current) return;
      setError(cause instanceof Error ? cause.message : "Konuşma yazıya çevrilemedi.");
      transition("error");
    } finally {
      stoppingRef.current = false;
      pcmCaptureRef.current = createVoicePcmCapture();
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
      setRecorderState({ durationMillis: 0, metering: undefined });
      void deactivateVoiceAudio().catch(() => undefined);
    }
  }, [connectionId, runtime, stream, transition]);

  useEffect(() => {
    if (phase !== "listening") return;
    const update = updateVoiceSilence(silenceRef.current, recorderState.durationMillis, recorderState.metering);
    silenceRef.current = update.state;
    if (update.shouldStop) void stopAndTranscribe();
    if (update.shouldReset) {
      silenceRef.current = { heardVoice: false, lastVoiceAtMs: 0 };
      pcmCaptureRef.current = createVoicePcmCapture();
      setRecorderState({ durationMillis: 0, metering: undefined });
    }
  }, [phase, recorderState.durationMillis, recorderState.metering, stopAndTranscribe]);

  useEffect(() => {
    if (scopeRef.current === sessionScope && !disabled) return;
    scopeRef.current = sessionScope;
    reset();
  }, [disabled, reset, sessionScope]);

  useEffect(() => () => {
    captureAttemptRef.current += 1;
    capturingRef.current = false;
    if (streamRef.current.isStreaming) streamRef.current.stop();
    void deactivateVoiceAudio().catch(() => undefined);
  }, []);

  const busy = ["permission", "listening", "transcribing"].includes(phase);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const recordingEnabled = !disabled && ["ready", "listening", "error"].includes(phase);
  const status = error ?? agentComposerVoiceStatus(phase, recorderState.durationMillis);

  return (
    <View style={styles.control}>
      {status === undefined ? null : (
        <View style={[styles.statusBubble, error !== undefined && styles.errorBubble]}>
          <Text style={[styles.statusText, error !== undefined && styles.errorText]}>{status}</Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={phase === "listening" ? "Kaydı bitir" : "Agent mesajını sesle yaz"}
        accessibilityState={{ disabled: !recordingEnabled, busy: ["permission", "transcribing"].includes(phase) }}
        disabled={!recordingEnabled}
        onPress={() => {
          if (phaseRef.current === "listening") void stopAndTranscribe();
          else void startRecording();
        }}
        style={({ pressed }) => [
          styles.button,
          phase === "listening" && styles.buttonRecording,
          !recordingEnabled && styles.buttonDisabled,
          pressed && recordingEnabled && styles.buttonPressed,
        ]}
      >
        {["permission", "transcribing"].includes(phase)
          ? <ActivityIndicator color={color.onAccent} />
          : <MicrophoneGlyph active={phase === "listening"} />}
      </Pressable>
    </View>
  );
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const styles = StyleSheet.create({
  control: { position: "relative" },
  button: {
    width: geometry.touchTarget,
    height: geometry.touchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.accentStrong,
    backgroundColor: color.accent,
  },
  buttonRecording: { borderColor: color.dangerBorder, backgroundColor: color.danger },
  buttonDisabled: { borderColor: color.border, backgroundColor: color.bgHover, opacity: 0.62 },
  buttonPressed: { opacity: 0.76 },
  statusBubble: {
    position: "absolute",
    right: 0,
    bottom: geometry.touchTarget + space.sm,
    width: 230,
    paddingHorizontal: space.sm,
    paddingVertical: 7,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: color.accent,
    backgroundColor: color.bgRaised,
  },
  errorBubble: { borderColor: color.dangerBorder },
  statusText: { color: color.accentStrong, fontFamily: fontFamily.mono, fontSize: 10.5, lineHeight: 15 },
  errorText: { color: color.danger },
});
