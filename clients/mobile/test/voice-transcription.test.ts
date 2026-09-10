import { afterEach, describe, expect, it, vi } from "vitest";
import { canRetryVoiceTranscription, retryableVoiceHttpStatus, VoiceTranscriptionError } from "../src/application/voice-transcription-error";
import { createVoiceTranscription, type VoiceTranscriptionState } from "../src/features/voice/voice-transcription";
import { appendVoiceFloatPcmBuffer, createVoicePcmCapture } from "../src/presentation/steward-voice-presentation";

const capture = () => appendVoiceFloatPcmBuffer(createVoicePcmCapture(), { data: new Float32Array(48_000).fill(0.25).buffer, sampleRate: 48_000, channels: 1 });
afterEach(() => vi.useRealTimers());

describe("retained voice transcription", () => {
  it("retries only on demand with identical bytes and target, then releases the recording", async () => {
    const transcribe = vi.fn().mockRejectedValueOnce(new TypeError("Network request failed")).mockRejectedValueOnce(new VoiceTranscriptionError("Busy", true, 503)).mockResolvedValue("hello");
    const h = harness(transcribe);
    await h.controller.start("mac-a", capture());
    expect(h.state()).toMatchObject({ phase: "failed", retryable: true });
    expect(transcribe).toHaveBeenCalledTimes(1);
    await h.controller.retry();
    expect(h.state()).toMatchObject({ phase: "failed", retryable: true });
    await h.controller.retry();
    expect(h.onTranscript).toHaveBeenCalledExactlyOnceWith("hello");
    expect(h.state().phase).toBe("idle");
    expect(transcribe.mock.calls.map(([id]) => id)).toEqual(["mac-a", "mac-a", "mac-a"]);
    expect(transcribe.mock.calls[1]![1]).toBe(transcribe.mock.calls[0]![1]);
    expect(transcribe.mock.calls[2]![1]).toBe(transcribe.mock.calls[0]![1]);
    await h.controller.retry();
    expect(transcribe).toHaveBeenCalledTimes(3);
  });

  it("cancels a failed recording and permits a fresh recording instead", async () => {
    const transcribe = vi.fn().mockRejectedValueOnce(new Error("Network request failed")).mockResolvedValue("new message");
    const h = harness(transcribe);
    await h.controller.start("mac-a", capture());
    h.controller.cancel();
    await h.controller.retry();
    expect(transcribe).toHaveBeenCalledTimes(1);
    await h.controller.start("mac-b", capture());
    expect(transcribe.mock.calls[1]![0]).toBe("mac-b");
    expect(transcribe.mock.calls[1]![1]).not.toBe(transcribe.mock.calls[0]![1]);
    expect(h.onTranscript).toHaveBeenCalledExactlyOnceWith("new message");
  });

  it("aborts cancellation, ignores a late response, and prevents double retries", async () => {
    const old = deferred<string>(), next = deferred<string>();
    const transcribe = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const h = harness(transcribe);
    const first = h.controller.start("mac-a", capture());
    const signal = transcribe.mock.calls[0]![2] as AbortSignal;
    h.controller.cancel();
    expect(signal.aborted).toBe(true);
    const second = h.controller.start("mac-a", capture());
    await h.controller.retry();
    old.resolve("discard this");
    await first;
    expect(h.state().phase).toBe("transcribing");
    expect(h.onTranscript).not.toHaveBeenCalled();
    next.resolve("keep this"); await second;
    expect(h.onTranscript).toHaveBeenCalledExactlyOnceWith("keep this");
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("times out a stalled request, retains its recording, and retries it without recording again", async () => {
    vi.useFakeTimers();
    const transcribe = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue("recovered");
    const h = harness(transcribe);
    const work = h.controller.start("mac-a", capture());
    await vi.advanceTimersByTimeAsync(45_000); await work;
    expect(h.state()).toMatchObject({ phase: "failed", retryable: true });
    expect((transcribe.mock.calls[0]![2] as AbortSignal).aborted).toBe(true);
    await h.controller.retry();
    expect(h.onTranscript).toHaveBeenCalledExactlyOnceWith("recovered");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 404, 413, 415, 422, 501, 505])("does not retry the same clip for permanent HTTP %i failures", async (status) => {
    const transcribe = vi.fn().mockRejectedValue(new VoiceTranscriptionError("Cannot transcribe", retryableVoiceHttpStatus(status), status));
    const h = harness(transcribe);
    await h.controller.start("mac-a", capture());
    expect(h.state()).toMatchObject({ phase: "failed", retryable: false });
    await h.controller.retry();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("rejects empty or too-short recordings without an upload", async () => {
    const transcribe = vi.fn();
    const h = harness(transcribe);
    await h.controller.start("mac-a", createVoicePcmCapture());
    expect(h.state()).toMatchObject({ phase: "failed", retryable: false });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it.each([408, 425, 429, 500, 502, 503, 504])("recognizes retryable HTTP %i failures", (status) => {
    expect(canRetryVoiceTranscription(new VoiceTranscriptionError("Temporary failure", retryableVoiceHttpStatus(status), status))).toBe(true);
  });
});

function harness(transcribe: ReturnType<typeof vi.fn>) {
  const states: VoiceTranscriptionState[] = [];
  const onTranscript = vi.fn();
  const controller = createVoiceTranscription({ transcribe, method: "agent", onState: (state) => states.push(state), onTranscript });
  return { controller, onTranscript, state: () => states.at(-1)! };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
