import { describe, expect, it } from "vitest";

import {
  agentComposerVoiceStatus,
  appendVoiceTranscript,
} from "../src/presentation/agent-composer-voice-presentation";

describe("Agent composer voice presentation", () => {
  it("adds a transcript without erasing an existing draft", () => {
    expect(appendVoiceTranscript("", "  fix the tests  ")).toBe("fix the tests");
    expect(appendVoiceTranscript("Check logs", "then fix it")).toBe("Check logs then fix it");
    expect(appendVoiceTranscript("Check logs\n", "then fix it")).toBe("Check logs\nthen fix it");
    expect(appendVoiceTranscript("keep this", "   ")).toBe("keep this");
  });

  it("states recording and transcription progress", () => {
    expect(agentComposerVoiceStatus("ready", 0)).toBeUndefined();
    expect(agentComposerVoiceStatus("listening", 1_240)).toContain("1.2 sn");
    expect(agentComposerVoiceStatus("transcribing", 0)).toContain("yazıya");
  });
});
