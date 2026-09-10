import type { StewardPort, StewardVoiceClip } from "../../application/ports";
import { canRetryVoiceTranscription, VoiceTranscriptionError } from "../../application/voice-transcription-error";
import { reportVoiceFailure } from "../../platform/voice-diagnostics";
import { createVoicePcmWav, type VoicePcmCapture } from "../../presentation/steward-voice-presentation";

export interface VoiceTranscriptionState {
  phase: "idle" | "transcribing" | "failed";
  error: string | undefined;
  retryable: boolean;
}

const idle: VoiceTranscriptionState = { phase: "idle", error: undefined, retryable: false };
const TRANSCRIPTION_TIMEOUT_MS = 45_000;

/** Owns one in-memory recording. Retries are explicit and reuse the same bytes
 * and Mac; cancellation invalidates even a response that ignores abort. */
export function createVoiceTranscription(options: {
  transcribe: StewardPort["transcribeVoice"];
  method: "agent" | "steward";
  onState(state: VoiceTranscriptionState): void;
  onTranscript(transcript: string): void;
}) {
  let pending: { connectionId: string; clip: StewardVoiceClip; capture: VoicePcmCapture } | undefined;
  let active: AbortController | undefined;
  let generation = 0;
  let state = idle;
  const publish = (next: VoiceTranscriptionState) => { state = next; options.onState(next); };
  const cancel = () => {
    generation += 1;
    active?.abort();
    active = undefined;
    pending = undefined;
    publish(idle);
  };
  const run = async () => {
    if (!pending || active) return;
    const work = pending;
    const attempt = ++generation;
    const controller = new AbortController();
    active = controller;
    publish({ phase: "transcribing", error: undefined, retryable: false });
    try {
      const transcript = await transcribeWithinDeadline(options.transcribe, work.connectionId, work.clip, controller);
      if (attempt !== generation) return;
      pending = undefined;
      publish(idle);
      options.onTranscript(transcript);
    } catch (cause) {
      if (attempt !== generation) return;
      const retryable = canRetryVoiceTranscription(cause);
      if (!retryable) pending = undefined;
      reportVoiceFailure(cause, options.method, "transcription", work.capture, work.clip.bytes.byteLength);
      publish({ phase: "failed", error: cause instanceof Error ? cause.message : "Konuşma yazıya çevrilemedi.", retryable });
    } finally {
      if (attempt === generation) active = undefined;
    }
  };
  return {
    cancel,
    async start(connectionId: string, capture: VoicePcmCapture) {
      cancel();
      try {
        if (capture.durationMillis < 250) throw new Error("Yeterli ses kaydedilemedi. Yeniden konuş.");
        const clip: StewardVoiceClip = { bytes: createVoicePcmWav(capture), mediaType: "audio/wav" };
        // Keep measurements for diagnostics, not a second copy of the PCM.
        pending = { connectionId, clip, capture: { ...capture, chunks: [] } };
      } catch (cause) {
        reportVoiceFailure(cause, options.method, "encoding", capture);
        publish({ phase: "failed", error: cause instanceof Error ? cause.message : "Kaydedilen ses hazırlanamadı.", retryable: false });
        return;
      }
      await run();
    },
    async retry() {
      if (state.phase === "failed" && state.retryable) await run();
    },
  };
}

async function transcribeWithinDeadline(
  transcribe: StewardPort["transcribeVoice"], connectionId: string, clip: StewardVoiceClip, controller: AbortController,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new VoiceTranscriptionError("Sesli mesaj iptal edildi.", false));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      reject(new VoiceTranscriptionError("Yazıya çevirme zaman aşımına uğradı.", true));
      controller.abort();
    }, TRANSCRIPTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([transcribe(connectionId, clip, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
