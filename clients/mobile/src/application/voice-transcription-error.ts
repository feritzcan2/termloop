export class VoiceTranscriptionError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "VoiceTranscriptionError";
  }
}

export function retryableVoiceHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429
    || (status >= 500 && status <= 599 && status !== 501 && status !== 505);
}

export function canRetryVoiceTranscription(cause: unknown): boolean {
  if (cause instanceof VoiceTranscriptionError) return cause.retryable;
  if (!(cause instanceof Error)) return false;
  return /network|failed to fetch|fetch failed|load failed|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i.test(cause.message);
}
