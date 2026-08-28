import { describe, expect, it } from "vitest";

import {
  appendVoiceFloatPcmBuffer,
  createVoicePcmCapture,
  createVoicePcmWav,
  stewardReplyAfter,
  updateVoiceSilence,
  voiceProjectId,
} from "../src/presentation/steward-voice-presentation";
import {
  fixtureProjects,
  fixtureSessions,
  fixtureStewardTranscript,
  fixtureTasks,
} from "../src/fixtures/mobile-overview";

const overview = {
  projects: fixtureProjects,
  tasks: fixtureTasks,
  sessions: fixtureSessions,
  agentStatuses: [],
};

describe("Steward voice presentation", () => {
  it("accumulates native PCM duration and metering before creating a WAV", () => {
    const nativeSamples = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    const expectedSamples = new Int16Array([16_384, -16_384, 16_384, -16_384]);
    const capture = appendVoiceFloatPcmBuffer(createVoicePcmCapture(), {
      data: nativeSamples.buffer,
      sampleRate: 4,
      channels: 1,
    });

    expect(capture.durationMillis).toBe(1_000);
    expect(capture.metering).toBeCloseTo(-6.02, 1);

    const wav = createVoicePcmWav(capture);
    const view = new DataView(wav);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(4);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(expectedSamples.byteLength);
    expect(new Int16Array(wav, 44)).toEqual(expectedSamples);
  });

  it("targets the route's Project, Task, or Session before falling back", () => {
    const projectId = fixtureProjects[0]!.id;
    expect(voiceProjectId({ projectId }, overview)).toBe(projectId);
    expect(voiceProjectId({ taskId: fixtureTasks[0]!.id }, overview)).toBe(fixtureTasks[0]!.project_id);
    expect(voiceProjectId({ sessionId: fixtureSessions[0]!.id }, overview)).toBe(fixtureSessions[0]!.project_id);
    expect(voiceProjectId({}, overview)).toBe(projectId);
  });

  it("selects only a Steward reply newer than the submitted voice turn", () => {
    const reply = stewardReplyAfter(fixtureStewardTranscript, 1);
    expect(reply?.author).toBe("steward");
    expect(reply?.sequence).toBeGreaterThan(1);
    expect(stewardReplyAfter(fixtureStewardTranscript, 10_000)).toBeUndefined();
  });

  it("stops after speech followed by silence and always enforces the hard ceiling", () => {
    const heard = updateVoiceSilence({ heardVoice: false, lastVoiceAtMs: 0 }, 900, -20);
    expect(heard.shouldStop).toBe(false);
    expect(updateVoiceSilence(heard.state, 2_200, -60).shouldStop).toBe(true);
    expect(updateVoiceSilence({ heardVoice: false, lastVoiceAtMs: 0 }, 30_000, -60).shouldStop).toBe(true);
  });
});

function ascii(view: DataView, offset: number, length: number): string {
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
}
