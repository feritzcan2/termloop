const AUDIO_SESSION_HANDOFF_RETRIES = 3;
const AUDIO_SESSION_HANDOFF_MS = 180;

type Wait = (milliseconds: number) => Promise<void>;

export interface StoppableVoiceAudioStream {
  readonly isStreaming: boolean;
  stop(): void;
}

/// `useAudioStream` owns the native shared object and can dispose it before a
/// consumer component's unmount cleanup runs. Both reading `isStreaming` and
/// calling `stop` then throw a synchronous Expo FunctionCallException, so every
/// best-effort cleanup must tolerate an already-released stream.
export function stopVoiceAudioStream(stream: StoppableVoiceAudioStream): void {
  try {
    if (stream.isStreaming) stream.stop();
  } catch {
    // The hook has already stopped and released this native stream.
  }
}

/// Expo's audio stream deactivates AVAudioSession as it stops. iOS can briefly
/// return `!pri` while that recording-to-playback handoff settles, so retry only
/// that transient condition and leave every other failure untouched.
export async function configureStewardAudioSession(
  operation: () => Promise<void>,
  wait: Wait = delay,
): Promise<void> {
  let lastCause: unknown;
  for (let attempt = 0; attempt < AUDIO_SESSION_HANDOFF_RETRIES; attempt += 1) {
    try {
      await operation();
      return;
    } catch (cause) {
      lastCause = cause;
      if (!isAudioSessionPriorityCause(cause) || attempt === AUDIO_SESSION_HANDOFF_RETRIES - 1) throw cause;
      await wait(AUDIO_SESSION_HANDOFF_MS * (attempt + 1));
    }
  }
  throw lastCause;
}

export function stewardVoiceAudioErrorMessage(cause: unknown, fallback: string): string {
  if (isAudioSessionPriorityCause(cause)) {
    return "iPhone ses geçişini tamamlayamadı. Bir an sonra tekrar dene.";
  }
  return cause instanceof Error ? cause.message : fallback;
}

export function canRetryVoiceRecording(cause: unknown): boolean {
  return isAudioSessionPriorityCause(cause)
    || (cause instanceof Error && cause.message.includes("Mikrofondan ses verisi alınamadı"));
}

function isAudioSessionPriorityCause(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("561017449") || message.includes("!pri");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
