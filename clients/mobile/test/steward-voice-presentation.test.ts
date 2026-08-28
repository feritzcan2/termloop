import { describe, expect, it } from "vitest";

import {
  createVoiceRecordingCompletion,
  startVoiceRecording,
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
  it("uses regular recording and waits for the native recorder to start", async () => {
    let recordCalls = 0;
    let checks = 0;
    const recorder = {
      record() { recordCalls += 1; },
      get isRecording() {
        checks += 1;
        return checks >= 2;
      },
    };

    await expect(startVoiceRecording(recorder, async () => undefined)).resolves.toBeUndefined();
    expect(recordCalls).toBe(1);
  });

  it("rejects when the native recorder never starts", async () => {
    const recorder = { record() {}, isRecording: false };

    await expect(startVoiceRecording(recorder, async () => undefined))
      .rejects.toThrow("Mikrofon kaydı başlatılamadı");
  });

  it("waits for the native recorder finish event before exposing its file", async () => {
    const completion = createVoiceRecordingCompletion();
    let resolved = false;
    completion.finished.then(() => { resolved = true; });

    completion.receive({ isFinished: false, hasError: false, error: null, url: "file:///partial.wav" });
    await Promise.resolve();
    expect(resolved).toBe(false);

    completion.receive({ isFinished: true, hasError: false, error: null, url: "file:///final.wav" });
    await expect(completion.finished).resolves.toBe("file:///final.wav");
  });

  it("rejects a failed native recording instead of uploading partial bytes", async () => {
    const completion = createVoiceRecordingCompletion();

    completion.receive({ isFinished: true, hasError: true, error: "encoder stopped", url: null });

    await expect(completion.finished).rejects.toThrow("encoder stopped");
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
