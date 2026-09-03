import { describe, expect, it } from "vitest";

import {
  appendVoiceFloatPcmBuffer,
  createVoicePcmCapture,
  createVoicePcmWav,
  updateVoiceSilence,
  voiceDetailsMaxHeight,
  voiceDockWidth,
  voiceProjectId,
} from "../src/presentation/steward-voice-presentation";
import {
  fixtureProjects,
  fixtureSessions,
  fixtureTasks,
} from "../src/fixtures/mobile-overview";

const overview = {
  projects: fixtureProjects,
  stewardEnabledProjectIds: fixtureProjects.map((project) => project.id),
  stewardExecutorSessionIds: {},
  agentGroupsByProject: {},
  tasks: fixtureTasks,
  sessions: fixtureSessions,
  agentStatuses: [],
};

describe("Steward voice presentation", () => {
  it("keeps voice details inside compact and large phone viewports", () => {
    expect(voiceDetailsMaxHeight(568)).toBe(272);
    expect(voiceDetailsMaxHeight(667)).toBe(320);
    expect(voiceDetailsMaxHeight(932)).toBe(420);
    expect(voiceDetailsMaxHeight(Number.NaN)).toBe(320);
  });

  it("keeps the floating voice dock inside the device's horizontal insets", () => {
    expect(voiceDockWidth(320)).toBe(292);
    expect(voiceDockWidth(393)).toBe(365);
    expect(voiceDockWidth(1_024)).toBe(560);
    expect(voiceDockWidth(Number.NaN)).toBe(362);
  });

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

  it("hides voice for explicitly scoped Projects without an enabled Steward", () => {
    const projectId = fixtureProjects[0]!.id;
    const disabled = { ...overview, stewardEnabledProjectIds: [] };

    expect(voiceProjectId({ projectId }, disabled)).toBeUndefined();
    expect(voiceProjectId({ taskId: fixtureTasks[0]!.id }, disabled)).toBeUndefined();
    expect(voiceProjectId({ sessionId: fixtureSessions[0]!.id }, disabled)).toBeUndefined();
    expect(voiceProjectId({}, disabled)).toBeUndefined();
  });

  it("stops a recorded message but rolls an entirely silent capture at the hard ceiling", () => {
    const heard = updateVoiceSilence({ heardVoice: false, lastVoiceAtMs: 0 }, 900, -20);
    expect(heard.shouldStop).toBe(false);
    expect(heard.shouldReset).toBe(false);
    expect(updateVoiceSilence(heard.state, 2_200, -60)).toMatchObject({ shouldStop: true, shouldReset: false });
    expect(updateVoiceSilence({ heardVoice: false, lastVoiceAtMs: 0 }, 30_000, -60))
      .toMatchObject({ shouldStop: false, shouldReset: true });
  });
});

function ascii(view: DataView, offset: number, length: number): string {
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
}
