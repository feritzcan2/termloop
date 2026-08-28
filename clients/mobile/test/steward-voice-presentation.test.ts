import { describe, expect, it } from "vitest";

import {
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
