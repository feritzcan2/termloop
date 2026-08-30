import { describe, expect, it, vi } from "vitest";

import {
  configureStewardAudioSession,
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
});
