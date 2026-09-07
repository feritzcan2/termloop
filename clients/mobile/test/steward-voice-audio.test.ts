import { describe, expect, it, vi } from "vitest";

import {
  configureStewardAudioSession,
  stopVoiceAudioStream,
  stewardVoiceAudioErrorMessage,
} from "../src/platform/steward-voice-audio";

describe("Steward voice audio session", () => {
  it("retries only the transient iOS recording-to-playback priority handoff", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("OSStatus error 561017449"))
      .mockRejectedValueOnce(new Error("AVAudioSession !pri"))
      .mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await configureStewardAudioSession(operation, wait);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[180], [360]]);
  });

  it("preserves other audio failures without retrying or exposing raw priority errors", async () => {
    const unavailable = new Error("Audio route unavailable");
    const operation = vi.fn().mockRejectedValue(unavailable);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(configureStewardAudioSession(operation, wait)).rejects.toBe(unavailable);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(stewardVoiceAudioErrorMessage(new Error("OSStatus error 561017449"), "fallback"))
      .toBe("iPhone ses geçişini tamamlayamadı. Bir an sonra tekrar dene.");
    expect(stewardVoiceAudioErrorMessage(undefined, "fallback")).toBe("fallback");
  });

  it("tolerates an audio stream that Expo already released during unmount", () => {
    const released = {
      get isStreaming(): boolean {
        throw new Error("Unable to find the native shared object");
      },
      stop: vi.fn(),
    };

    expect(() => stopVoiceAudioStream(released)).not.toThrow();
    expect(released.stop).not.toHaveBeenCalled();
  });

  it("stops a live stream and treats cleanup failures as already settled", () => {
    const stop = vi.fn(() => { throw new Error("native stream released"); });

    expect(() => stopVoiceAudioStream({ isStreaming: true, stop })).not.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });
});
