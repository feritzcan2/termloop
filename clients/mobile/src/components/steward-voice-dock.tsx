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
import { KeyboardAvoidingView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { StewardMessage, StewardVoiceReceipt } from "@/application/ports";
import { StewardVoiceControls } from "@/components/steward-voice-controls";
import { useMobileRuntime } from "@/composition/runtime-context";
import {
  CONNECTION_RECONNECT_GRACE_MS,
  useConnections,
} from "@/features/connection/connection-store";
import { useOverview } from "@/features/overview/overview-store";
import {
  appendVoiceFloatPcmBuffer,
  createVoicePcmCapture,
  createVoicePcmWav,
  resumeVoiceTranscript,
  updateVoiceSilence,
  updateVoiceTranscript,
  updateVoiceTurn,
  voiceProjectId,
  voiceTurnForReply,
  type VoiceMode,
  type VoicePcmCapture,
  type VoicePhase,
  type VoiceRouteParams,
  type VoiceSilenceState,
  type VoiceTurn,
} from "@/presentation/steward-voice-presentation";
import { stewardLiveActivity } from "@/platform/steward-live-activity";
import { stewardLocalSpeech } from "@/platform/steward-local-speech";
import { space } from "@/theme/tokens";

interface QueuedSpeech {
  readonly message: StewardMessage;
  readonly attempts: number;
  readonly acknowledge: boolean;
}

const TRANSCRIPT_POLL_MS = 1_250;
const PCM_STREAM_START_TIMEOUT_MS = 2_000;
const MIN_CAPTURE_MS = 250;
const STEWARD_RECORDING_MEDIA_TYPE = "audio/wav";
const SPEECH_RETRY_LIMIT = 2;
const SPEECH_RETRY_MS = 1_500;
const REVIEW_AUTO_SEND_MS = 5_000;

/// The voice session is independent from its detail sheet. Collapsing the sheet
/// keeps transcript polling, speech delivery, background recording, and the Live
/// Activity alive; only the explicit × ends the session.
export function StewardVoiceDock() {
  const runtime = useMobileRuntime();
  const connections = useConnections();
  const overview = useOverview();
  const insets = useSafeAreaInsets();
  const routeParams = useGlobalSearchParams() as VoiceRouteParams;
  const routeProjectId = voiceProjectId(routeParams, overview.overview);
  const projects = overview.overview?.projects ?? [];

  const [sessionActive, setSessionActive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(routeProjectId);
  const [phase, setPhase] = useState<VoicePhase>("ready");
  const [mode, setMode] = useState<VoiceMode>("single");
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [turns, setTurns] = useState<readonly VoiceTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [editingDraft, setEditingDraft] = useState(false);
  const [autoSendSeconds, setAutoSendSeconds] = useState<number | null>(null);
  const [lastReply, setLastReply] = useState<StewardMessage | undefined>(undefined);
  const [unreadCount, setUnreadCount] = useState(0);
  const [recorderState, setRecorderState] = useState<{ durationMillis: number; metering: number | undefined }>({
    durationMillis: 0,
    metering: undefined,
  });
  const [speechQueueRevision, setSpeechQueueRevision] = useState(0);

  const sessionActiveRef = useRef(false);
  const expandedRef = useRef(false);
  const phaseRef = useRef<VoicePhase>("ready");
  const modeRef = useRef<VoiceMode>("single");
  const microphoneEnabledRef = useRef(false);
  const conversationRef = useRef(0);
  const captureAttemptRef = useRef(0);
  const stoppingRef = useRef(false);
  const silenceRef = useRef<VoiceSilenceState>({ heardVoice: false, lastVoiceAtMs: 0 });
  const activeTargetRef = useRef<{ connectionId: string; projectId: string } | undefined>(undefined);
  const receiptRef = useRef<StewardVoiceReceipt>({
    initialized: false,
    acknowledgedSequence: 0,
    pendingUserSequence: null,
  });
  const transcriptCursorRef = useRef(0);
  const transcriptSeededRef = useRef(false);
  const bootstrappingRef = useRef(false);
  const pollingRef = useRef(false);
  const pollFailureSinceRef = useRef<number | null>(null);
  const speechQueueRef = useRef<QueuedSpeech[]>([]);
  const queuedSequencesRef = useRef(new Set<number>());
  const activeSpeechRef = useRef<QueuedSpeech | undefined>(undefined);
  const speechBlockedRef = useRef(false);
  const speechStartingRef = useRef(false);
  const speechRetryAtRef = useRef(0);
  const speechFileRef = useRef<File | undefined>(undefined);
  const speakingConversationRef = useRef(0);
  const pcmCaptureRef = useRef<VoicePcmCapture>(createVoicePcmCapture());
  const capturingRef = useRef(false);
  const firstBufferRef = useRef<(() => void) | undefined>(undefined);
  const turnsRef = useRef<readonly VoiceTurn[]>([]);
  const draftRef = useRef("");
  const activeTurnIdRef = useRef<string | undefined>(undefined);
  const turnCounterRef = useRef(0);
  const reviewDeadlineRef = useRef(0);
  const reviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reviewIntervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const commitDraftRef = useRef<() => void>(() => undefined);

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
  const playerRef = useRef(player);
  const streamRef = useRef(stream);
  playerRef.current = player;
  streamRef.current = stream;

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

  const changeTurns = useCallback((update: (current: readonly VoiceTurn[]) => readonly VoiceTurn[]) => {
    const next = update(turnsRef.current);
    turnsRef.current = next;
    setTurns(next);
  }, []);

  const cleanSpeechFile = useCallback(() => {
    const file = speechFileRef.current;
    speechFileRef.current = undefined;
    if (file?.exists) {
      try { file.delete(); } catch { /* The cache may evict speech first. */ }
    }
  }, []);

  const clearReviewTimers = useCallback(() => {
    if (reviewTimeoutRef.current !== undefined) clearTimeout(reviewTimeoutRef.current);
    if (reviewIntervalRef.current !== undefined) clearInterval(reviewIntervalRef.current);
    reviewTimeoutRef.current = undefined;
    reviewIntervalRef.current = undefined;
    reviewDeadlineRef.current = 0;
    setAutoSendSeconds(null);
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

  const persistReceipt = useCallback(async (receipt: StewardVoiceReceipt) => {
    receiptRef.current = receipt;
    const target = activeTargetRef.current;
    if (target === undefined) return;
    await runtime.voiceReceipts.write(target.connectionId, target.projectId, receipt);
  }, [runtime]);

  const enqueueSpeech = useCallback((message: StewardMessage, acknowledge = true, force = false) => {
    if (acknowledge) {
      if (message.sequence <= receiptRef.current.acknowledgedSequence) return;
      if (!force && queuedSequencesRef.current.has(message.sequence)) return;
      queuedSequencesRef.current.add(message.sequence);
      setUnreadCount(queuedSequencesRef.current.size);
    }
    const turnId = voiceTurnForReply(turnsRef.current, receiptRef.current.pendingUserSequence, message);
    if (turnId !== undefined) {
      changeTurns((current) => updateVoiceTurn(current, turnId, { status: "answered", reply: message }));
    }
    setLastReply(message);
    speechQueueRef.current.push({ message, attempts: 0, acknowledge });
    setSpeechQueueRevision((revision) => revision + 1);
  }, [changeTurns]);

  const ingestTranscript = useCallback(async (messages: readonly StewardMessage[]) => {
    const latestSteward = [...messages]
      .filter((message) => message.author === "steward")
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (latestSteward !== undefined) setLastReply(latestSteward);

    if (!transcriptSeededRef.current) {
      const resumed = resumeVoiceTranscript(messages, receiptRef.current);
      transcriptCursorRef.current = resumed.cursor;
      transcriptSeededRef.current = true;
      if (resumed.receipt !== receiptRef.current) await persistReceipt(resumed.receipt);
      const pending = resumed.receipt.pendingUserSequence;
      if (pending !== null && !turnsRef.current.some((turn) => turn.userSequence === pending)) {
        const user = messages.find((message) => message.author === "user" && message.sequence === pending);
        changeTurns((current) => [...current, {
          id: `persisted-${pending}`,
          transcript: user?.content ?? "Önceki sesli mesaj",
          status: "thinking",
          userSequence: pending,
          reply: null,
          error: null,
        }]);
      }
      for (const message of resumed.stewardMessages) enqueueSpeech(message);
      return;
    }

    const update = updateVoiceTranscript(messages, transcriptCursorRef.current);
    transcriptCursorRef.current = update.cursor;
    for (const message of update.stewardMessages) enqueueSpeech(message);
  }, [changeTurns, enqueueSpeech, persistReceipt]);

  const startListening = useCallback(async (conversation: number) => {
    if (conversation !== conversationRef.current || !sessionActiveRef.current
      || !microphoneEnabledRef.current || phaseRef.current === "speaking"
      || ["transcribing", "reviewing", "sending"].includes(phaseRef.current)) return;
    const attempt = captureAttemptRef.current + 1;
    captureAttemptRef.current = attempt;
    if (activeTargetRef.current === undefined) {
      setMicrophone(false);
      setError("Önce çevrimiçi bir Mac ve Steward projesi seç.");
      transition("error");
      return;
    }
    transition("permission");
    setError(undefined);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Mikrofon izni olmadan konuşma başlatılamaz.");
      if (attempt !== captureAttemptRef.current || conversation !== conversationRef.current
        || !sessionActiveRef.current || !microphoneEnabledRef.current) return;
      await configureVoiceRecordingAudio();
      if (attempt !== captureAttemptRef.current || conversation !== conversationRef.current
        || !sessionActiveRef.current || !microphoneEnabledRef.current) return;
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
        || !sessionActiveRef.current || !microphoneEnabledRef.current) {
        if (attempt === captureAttemptRef.current) {
          stopCapture();
          if (conversation === conversationRef.current && sessionActiveRef.current) transition("ready");
        }
        return;
      }
      transition("listening");
    } catch (cause) {
      const stillCurrent = attempt === captureAttemptRef.current;
      if (!stillCurrent || conversation !== conversationRef.current) return;
      stopCapture();
      setMicrophone(false);
      setError(describe(cause, "Mikrofon başlatılamadı."));
      transition("error");
    }
  }, [cleanSpeechFile, setMicrophone, stopCapture, stream, transition]);

  const beginReview = useCallback((transcript: string) => {
    clearReviewTimers();
    turnCounterRef.current += 1;
    const id = `turn-${Date.now()}-${turnCounterRef.current}`;
    activeTurnIdRef.current = id;
    draftRef.current = transcript;
    setDraft(transcript);
    setEditingDraft(false);
    changeTurns((current) => [...current, {
      id,
      transcript,
      status: "received",
      userSequence: null,
      reply: null,
      error: null,
    }]);
    expandedRef.current = true;
    setExpanded(true);
    transition("reviewing");
    reviewDeadlineRef.current = Date.now() + REVIEW_AUTO_SEND_MS;
    setAutoSendSeconds(Math.ceil(REVIEW_AUTO_SEND_MS / 1_000));
    reviewIntervalRef.current = setInterval(() => {
      setAutoSendSeconds(Math.max(1, Math.ceil((reviewDeadlineRef.current - Date.now()) / 1_000)));
    }, 250);
    reviewTimeoutRef.current = setTimeout(() => commitDraftRef.current(), REVIEW_AUTO_SEND_MS);
  }, [changeTurns, clearReviewTimers, transition]);

  const stopAndPreview = useCallback(async () => {
    if (phaseRef.current !== "listening" || stoppingRef.current) return;
    stoppingRef.current = true;
    const conversation = conversationRef.current;
    const target = activeTargetRef.current;
    const capture = pcmCaptureRef.current;
    captureAttemptRef.current += 1;
    capturingRef.current = false;
    firstBufferRef.current = undefined;
    if (stream.isStreaming) stream.stop();
    transition("transcribing");
    if (modeRef.current === "single") setMicrophone(false);
    try {
      if (capture.durationMillis < MIN_CAPTURE_MS) throw new Error("Yeterli ses kaydedilemedi. Yeniden konuş.");
      if (target === undefined) throw new Error("Kaydedilen ses hazırlanamadı.");
      const transcript = await runtime.steward.transcribeVoice(target.connectionId, {
        bytes: createVoicePcmWav(capture),
        mediaType: STEWARD_RECORDING_MEDIA_TYPE,
      });
      if (conversation !== conversationRef.current || !sessionActiveRef.current) return;
      setError(undefined);
      beginReview(transcript);
    } catch (cause) {
      if (conversation !== conversationRef.current) return;
      setError(describe(cause, "Konuşma yazıya çevrilemedi."));
      transition("error");
    } finally {
      stoppingRef.current = false;
      pcmCaptureRef.current = createVoicePcmCapture();
      setRecorderState({ durationMillis: 0, metering: undefined });
    }
  }, [beginReview, runtime, setMicrophone, stream, transition]);

  const commitDraft = useCallback(async () => {
    if (phaseRef.current !== "reviewing") return;
    const text = draftRef.current.trim();
    const turnId = activeTurnIdRef.current;
    const target = activeTargetRef.current;
    if (text.length === 0 || turnId === undefined || target === undefined) return;
    clearReviewTimers();
    setEditingDraft(false);
    changeTurns((current) => updateVoiceTurn(current, turnId, {
      transcript: text,
      status: "sent",
      error: null,
    }));
    transition("sending");
    try {
      const appended = await runtime.steward.commitVoice(target.connectionId, target.projectId, text);
      if (!sessionActiveRef.current || target !== activeTargetRef.current) return;
      changeTurns((current) => updateVoiceTurn(current, turnId, {
        transcript: appended.transcript,
        status: "thinking",
        userSequence: appended.userSequence,
      }));
      const receipt = {
        ...receiptRef.current,
        initialized: true,
        pendingUserSequence: appended.userSequence,
      };
      try {
        await persistReceipt(receipt);
      } catch {
        receiptRef.current = receipt;
        setError("Mesaj gönderildi; okundu bilgisi bu kez telefona kaydedilemedi.");
      }
      draftRef.current = "";
      activeTurnIdRef.current = undefined;
      setDraft("");
      transition("thinking");
    } catch (cause) {
      if (!sessionActiveRef.current) return;
      const message = describe(cause, "Sesli mesaj gönderilemedi.");
      changeTurns((current) => updateVoiceTurn(current, turnId, { status: "failed", error: message }));
      setError(message);
      setEditingDraft(true);
      transition("reviewing");
    }
  }, [changeTurns, clearReviewTimers, persistReceipt, runtime, transition]);
  commitDraftRef.current = () => { void commitDraft(); };

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

  const finishSpeech = useCallback(async (queued: QueuedSpeech, conversation: number) => {
    if (conversation !== conversationRef.current || !sessionActiveRef.current) return;
    activeSpeechRef.current = undefined;
    cleanSpeechFile();
    const pending = receiptRef.current.pendingUserSequence;
    const turnId = turnsRef.current.find((turn) => turn.reply?.sequence === queued.message.sequence)?.id
      ?? voiceTurnForReply(turnsRef.current, pending, queued.message);
    if (turnId !== undefined) {
      changeTurns((current) => updateVoiceTurn(current, turnId, { status: "spoken", reply: queued.message }));
    }
    if (queued.acknowledge) {
      queuedSequencesRef.current.delete(queued.message.sequence);
      setUnreadCount(queuedSequencesRef.current.size);
      const receipt: StewardVoiceReceipt = {
        initialized: true,
        acknowledgedSequence: Math.max(receiptRef.current.acknowledgedSequence, queued.message.sequence),
        pendingUserSequence: pending !== null && queued.message.sequence > pending ? null : pending,
      };
      try {
        await persistReceipt(receipt);
      } catch {
        receiptRef.current = receipt;
        setError("Cevap okundu; okundu bilgisi bu kez telefona kaydedilemedi.");
      }
    }
    if (modeRef.current === "single") setMicrophone(false);
    transition(receiptRef.current.pendingUserSequence === null ? "ready" : "thinking");
    setSpeechQueueRevision((revision) => revision + 1);
    if (speechQueueRef.current.length === 0
      && modeRef.current === "handsFree" && microphoneEnabledRef.current) {
      setTimeout(() => { void startListening(conversation); }, 450);
    }
  }, [changeTurns, cleanSpeechFile, persistReceipt, setMicrophone, startListening, transition]);

  const playNextSpeech = useCallback(async (conversation: number) => {
    if (speechStartingRef.current || activeSpeechRef.current !== undefined
      || conversation !== conversationRef.current || !sessionActiveRef.current) return;
    if (["connecting", "permission", "transcribing", "reviewing", "sending", "speaking"].includes(phaseRef.current)) return;
    if (phaseRef.current === "listening" && silenceRef.current.heardVoice) return;
    const retryDelay = speechRetryAtRef.current - Date.now();
    if (retryDelay > 0) {
      setTimeout(() => {
        if (conversation === conversationRef.current && sessionActiveRef.current) {
          setSpeechQueueRevision((revision) => revision + 1);
        }
      }, retryDelay);
      return;
    }
    const queued = speechQueueRef.current.shift();
    if (queued === undefined) return;
    speechStartingRef.current = true;
    speechRetryAtRef.current = 0;
    activeSpeechRef.current = queued;
    if (phaseRef.current === "listening") stopCapture();
    const turnId = turnsRef.current.find((turn) => turn.reply?.sequence === queued.message.sequence)?.id;
    if (turnId !== undefined) {
      changeTurns((current) => updateVoiceTurn(current, turnId, { status: "speaking" }));
    }
    setLastReply(queued.message);
    setError(undefined);
    transition("speaking");
    const target = activeTargetRef.current;
    try {
      if (target === undefined) throw new Error("Steward ses hedefi artık kullanılamıyor.");
      if (runtime.kind === "mock") {
        await delay(400);
        await finishSpeech(queued, conversation);
        return;
      }
      const audio = await runtime.steward.speech(target.connectionId, target.projectId, queued.message.sequence);
      if (conversation !== conversationRef.current || !sessionActiveRef.current) return;
      cleanSpeechFile();
      const file = new File(Paths.cache, `termloop-steward-${conversation}-${queued.message.sequence}.mp3`);
      file.write(audio);
      speechFileRef.current = file;
      speakingConversationRef.current = conversation;
      await configureVoicePlaybackAudio();
      player.replace(file.uri);
      player.play();
      return;
    } catch (remoteCause) {
      if (conversation !== conversationRef.current || !sessionActiveRef.current) return;
      if (queued.attempts < SPEECH_RETRY_LIMIT) {
        activeSpeechRef.current = undefined;
        speechQueueRef.current.unshift({ ...queued, attempts: queued.attempts + 1 });
        speechRetryAtRef.current = Date.now() + SPEECH_RETRY_MS;
        transition(receiptRef.current.pendingUserSequence === null ? "ready" : "thinking");
        setSpeechQueueRevision((revision) => revision + 1);
        return;
      }
      try {
        await configureVoicePlaybackAudio();
        const spoken = await stewardLocalSpeech.speak(queued.message.content);
        if (!spoken) throw new Error("iPhone seslendirmesi kullanılamıyor.");
        await finishSpeech(queued, conversation);
        return;
      } catch (localCause) {
        activeSpeechRef.current = undefined;
        speechBlockedRef.current = true;
        speechQueueRef.current.unshift(queued);
        if (turnId !== undefined) {
          changeTurns((current) => updateVoiceTurn(current, turnId, { status: "answered" }));
        }
        setError(`${describe(remoteCause, "Mac sesi üretilemedi.")} ${describe(localCause, "iPhone da okuyamadı.")}`);
        transition("error");
      }
    } finally {
      speechStartingRef.current = false;
    }
  }, [changeTurns, cleanSpeechFile, finishSpeech, player, runtime, stopCapture, transition]);

  useEffect(() => {
    if (!sessionActive || speechQueueRef.current.length === 0 || speechStartingRef.current
      || activeSpeechRef.current !== undefined || speechBlockedRef.current) return;
    if (["connecting", "permission", "transcribing", "reviewing", "sending", "speaking"].includes(phase)) return;
    if (phase === "listening" && silenceRef.current.heardVoice) return;
    void playNextSpeech(conversationRef.current);
  }, [phase, playNextSpeech, sessionActive, speechQueueRevision]);

  useEffect(() => {
    if (phase !== "speaking" || !playerStatus.didJustFinish) return;
    const queued = activeSpeechRef.current;
    if (queued !== undefined) void finishSpeech(queued, speakingConversationRef.current);
  }, [finishSpeech, phase, playerStatus.didJustFinish]);

  const beginSession = useCallback(async (
    conversation: number,
    target: { connectionId: string; projectId: string },
  ) => {
    bootstrappingRef.current = true;
    transition("connecting");
    try {
      const receipt = await runtime.voiceReceipts.read(target.connectionId, target.projectId);
      if (conversation !== conversationRef.current || !sessionActiveRef.current) return;
      receiptRef.current = receipt;
      transcriptCursorRef.current = receipt.acknowledgedSequence;
      const messages = await runtime.steward.transcript(target.connectionId, target.projectId);
      if (conversation !== conversationRef.current || !sessionActiveRef.current) return;
      await ingestTranscript(messages);
      pollFailureSinceRef.current = null;
      setError(undefined);
      transition(receiptRef.current.pendingUserSequence === null ? "ready" : "thinking");
      if (speechQueueRef.current.length > 0) setSpeechQueueRevision((revision) => revision + 1);
      else if (microphoneEnabledRef.current) void startListening(conversation);
    } catch {
      if (conversation !== conversationRef.current) return;
      transcriptSeededRef.current = false;
      pollFailureSinceRef.current = Date.now();
      setError(undefined);
      transition("reconnecting");
    } finally {
      bootstrappingRef.current = false;
    }
  }, [ingestTranscript, runtime, startListening, transition]);

  useEffect(() => {
    if (!sessionActive) return;
    let cancelled = false;
    const poll = async () => {
      const target = activeTargetRef.current;
      if (cancelled || pollingRef.current || bootstrappingRef.current || target === undefined) return;
      pollingRef.current = true;
      try {
        const messages = await runtime.steward.transcript(target.connectionId, target.projectId);
        if (cancelled || target !== activeTargetRef.current || !sessionActiveRef.current) return;
        await ingestTranscript(messages);
        pollFailureSinceRef.current = null;
        if (["reconnecting", "offline"].includes(phaseRef.current)) {
          setError(undefined);
          transition(receiptRef.current.pendingUserSequence === null ? "ready" : "thinking");
          if (microphoneEnabledRef.current && speechQueueRef.current.length === 0) {
            void startListening(conversationRef.current);
          }
        }
      } catch (cause) {
        if (cancelled) return;
        const startedAt = pollFailureSinceRef.current ?? Date.now();
        pollFailureSinceRef.current = startedAt;
        const interruptible = ["ready", "thinking", "reconnecting", "offline", "error"].includes(phaseRef.current);
        if (interruptible && Date.now() - startedAt < CONNECTION_RECONNECT_GRACE_MS) {
          setError(undefined);
          transition("reconnecting");
        } else if (interruptible) {
          setError(describe(cause, "Mac’e ulaşılamıyor. Yeniden bağlanmayı sürdürüyorum."));
          transition("offline");
        }
      } finally {
        pollingRef.current = false;
      }
    };
    const handle = setInterval(() => { void poll(); }, TRANSCRIPT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [ingestTranscript, runtime, sessionActive, startListening, transition]);

  const endConversation = useCallback(() => {
    conversationRef.current += 1;
    sessionActiveRef.current = false;
    expandedRef.current = false;
    setSessionActive(false);
    setExpanded(false);
    setMicrophone(false);
    clearReviewTimers();
    player.pause();
    stewardLocalSpeech.stop();
    cleanSpeechFile();
    stopCapture();
    stoppingRef.current = false;
    speechStartingRef.current = false;
    speechRetryAtRef.current = 0;
    speechQueueRef.current = [];
    speechBlockedRef.current = false;
    queuedSequencesRef.current.clear();
    activeSpeechRef.current = undefined;
    transcriptCursorRef.current = 0;
    transcriptSeededRef.current = false;
    bootstrappingRef.current = false;
    pollFailureSinceRef.current = null;
    activeTargetRef.current = undefined;
    setUnreadCount(0);
    setError(undefined);
    setTurns([]);
    turnsRef.current = [];
    setDraft("");
    draftRef.current = "";
    activeTurnIdRef.current = undefined;
    transition("ready");
    void stewardLiveActivity.end().catch(() => undefined);
    void deactivateVoiceAudio().catch(() => undefined);
  }, [cleanSpeechFile, clearReviewTimers, player, setMicrophone, stopCapture, transition]);

  const openConversation = useCallback(() => {
    const project = projects.find((candidate) => candidate.id === routeProjectId) ?? selectedProject;
    const connectionId = connections.selected?.id;
    const conversation = conversationRef.current + 1;
    conversationRef.current = conversation;
    sessionActiveRef.current = true;
    expandedRef.current = true;
    modeRef.current = "single";
    setSessionActive(true);
    setExpanded(true);
    setMode("single");
    setMicrophone(true);
    setError(undefined);
    setTurns([]);
    turnsRef.current = [];
    queuedSequencesRef.current.clear();
    speechQueueRef.current = [];
    speechBlockedRef.current = false;
    setUnreadCount(0);
    transcriptSeededRef.current = false;
    if (project === undefined || connectionId === undefined) {
      setMicrophone(false);
      setError("Önce çevrimiçi bir Mac ve Steward projesi seç.");
      transition("error");
      return;
    }
    setSelectedProjectId(project.id);
    const target = { connectionId, projectId: project.id };
    activeTargetRef.current = target;
    void beginSession(conversation, target);
  }, [beginSession, connections.selected?.id, projects, routeProjectId, selectedProject, setMicrophone, transition]);

  const toggleMicrophone = useCallback(() => {
    if (microphoneEnabledRef.current) {
      setMicrophone(false);
      stopCapture();
      if (["listening", "permission"].includes(phaseRef.current)) transition("ready");
      if (phaseRef.current !== "speaking") void configureVoicePlaybackAudio().catch(() => undefined);
      return;
    }
    setMicrophone(true);
    setError(undefined);
    if (["ready", "error"].includes(phaseRef.current)) void startListening(conversationRef.current);
  }, [setMicrophone, startListening, stopCapture, transition]);

  const changeMode = useCallback((next: VoiceMode) => {
    modeRef.current = next;
    setMode(next);
    if (next === "single") {
      setMicrophone(false);
      if (["listening", "permission"].includes(phaseRef.current)) {
        stopCapture();
        transition("ready");
      }
      return;
    }
    setMicrophone(true);
    if (["ready", "error"].includes(phaseRef.current)) void startListening(conversationRef.current);
  }, [setMicrophone, startListening, stopCapture, transition]);

  const beginCorrection = useCallback(() => {
    if (phaseRef.current !== "reviewing") return;
    clearReviewTimers();
    setEditingDraft(true);
  }, [clearReviewTimers]);

  const changeDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
    const turnId = activeTurnIdRef.current;
    if (turnId !== undefined) {
      changeTurns((current) => updateVoiceTurn(current, turnId, { transcript: value, status: "received" }));
    }
  }, [changeTurns]);

  const replayLastReply = useCallback(() => {
    const blocked = speechQueueRef.current[0];
    if (speechBlockedRef.current && blocked !== undefined) {
      speechBlockedRef.current = false;
      speechQueueRef.current[0] = { ...blocked, attempts: 0 };
      transition(receiptRef.current.pendingUserSequence === null ? "ready" : "thinking");
      setSpeechQueueRevision((revision) => revision + 1);
      return;
    }
    if (lastReply === undefined) return;
    const acknowledge = lastReply.sequence > receiptRef.current.acknowledgedSequence;
    enqueueSpeech(lastReply, acknowledge, true);
  }, [enqueueSpeech, lastReply, transition]);

  useEffect(() => {
    if (!sessionActiveRef.current && routeProjectId !== undefined) setSelectedProjectId(routeProjectId);
  }, [routeProjectId]);

  useEffect(() => {
    const activeConnectionId = activeTargetRef.current?.connectionId;
    if (sessionActiveRef.current && activeConnectionId !== undefined
      && activeConnectionId !== connections.selected?.id) endConversation();
  }, [connections.selected?.id, endConversation]);

  useEffect(() => {
    const target = activeTargetRef.current;
    if (!sessionActive || selectedProject === undefined || target?.projectId !== selectedProject.id) return;
    void stewardLiveActivity.sync({
      projectId: selectedProject.id,
      projectName: selectedProject.name,
      status: liveActivityStatus(phase),
      microphoneEnabled,
    }).catch(() => undefined);
  }, [microphoneEnabled, phase, selectedProject, sessionActive]);

  useEffect(() => () => {
    playerRef.current.pause();
    stewardLocalSpeech.stop();
    if (streamRef.current.isStreaming) streamRef.current.stop();
    void stewardLiveActivity.end().catch(() => undefined);
  }, []);

  return (
    <KeyboardAvoidingView
      behavior="position"
      pointerEvents="box-none"
      style={[styles.overlay, { bottom: insets.bottom + 8 }]}
    >
      <StewardVoiceControls
        active={sessionActive}
        autoSendSeconds={autoSendSeconds}
        canReplay={lastReply !== undefined}
        draft={draft}
        durationMillis={recorderState.durationMillis}
        editingDraft={editingDraft}
        error={error}
        expanded={expanded}
        microphoneEnabled={microphoneEnabled}
        mode={mode}
        onBeginCorrection={beginCorrection}
        onCommitDraft={() => { void commitDraft(); }}
        onDraftChange={changeDraft}
        onEnd={endConversation}
        onModeChange={changeMode}
        onReplay={replayLastReply}
        onStart={openConversation}
        onToggleExpanded={() => {
          expandedRef.current = !expandedRef.current;
          setExpanded(expandedRef.current);
        }}
        onToggleMicrophone={toggleMicrophone}
        phase={phase}
        projectName={selectedProject?.name ?? "Steward"}
        turns={turns}
        unreadCount={unreadCount}
      />
    </KeyboardAvoidingView>
  );
}

function liveActivityStatus(phase: VoicePhase): string {
  switch (phase) {
    case "connecting": return "Bağlanıyor";
    case "ready": return "Hazır";
    case "permission": return "Mikrofon hazırlanıyor";
    case "listening": return "Dinliyor";
    case "transcribing": return "Yazıya çeviriyor";
    case "reviewing": return "Onay bekliyor";
    case "sending": return "Gönderiliyor";
    case "thinking": return "Steward düşünüyor";
    case "speaking": return "Steward konuşuyor";
    case "reconnecting": return "Yeniden bağlanıyor";
    case "offline": return "Mac’e ulaşılamıyor";
    case "error": return "Tekrar denemeye hazır";
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    allowsBackgroundRecording: true,
    shouldPlayInBackground: true,
    shouldRouteThroughEarpiece: false,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
  });
}

async function configureVoicePlaybackAudio(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    allowsBackgroundRecording: false,
    shouldPlayInBackground: true,
    shouldRouteThroughEarpiece: false,
    playsInSilentMode: true,
    interruptionMode: "doNotMix",
  });
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
});
