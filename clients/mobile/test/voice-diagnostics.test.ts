import { describe, expect, it, vi } from "vitest";
import { createMobileDiagnosticReporter } from "../src/platform/mobile-diagnostics";
import { reportVoiceFailure } from "../src/platform/voice-diagnostics";
import { createVoicePcmCapture } from "../src/presentation/steward-voice-presentation";

describe("voice failure diagnostics", () => {
  it.each([
    ["Network request failed", "network"],
    ["This recording cannot be transcribed.", "invalid_clip"],
    ["AVAudioSession !pri 561017449", "audio_session_busy"],
    ["I could not hear speech in that recording.", "no_speech"],
    ["Mikrofondan ses verisi alınamadı.", "no_audio_buffer"],
  ])("classifies %s without sending exception text", (message, reason) => {
    const emit = vi.fn();
    const reporter = createMobileDiagnosticReporter(() => {}, { now: () => 10 }, emit);
    reportVoiceFailure(new Error(`${message} PRIVATE https://secret.example/token`), "agent", "transcription", { ...createVoicePcmCapture(), byteLength: 2_880_000, durationMillis: 30_000, sampleRate: 48_000, channels: 1 }, 960_044, reporter);
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "voice_transcription_failed", details: { method: "agent", reason, durationMs: 30_000, captureBytes: 2_880_000, sampleRate: 48_000, channels: 1, uploadBytes: 960_044 } }));
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(/PRIVATE|secret.example/);
  });
});
