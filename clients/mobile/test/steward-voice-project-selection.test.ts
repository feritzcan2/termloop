import { describe, expect, it } from "vitest";

import {
  canSwitchVoiceProject,
  enabledVoiceProjects,
  switchableVoiceProject,
} from "../src/presentation/steward-voice-project-selection";
import { fixtureProjects } from "../src/fixtures/mobile-overview";

describe("Steward voice project selection", () => {
  it("offers only Projects whose Steward configuration is enabled", () => {
    const enabledProject = fixtureProjects[0]!;
    expect(enabledVoiceProjects({
      projects: fixtureProjects,
      stewardEnabledProjectIds: [enabledProject.id],
      stewardExecutorSessionIds: {},
      tasks: [],
      sessions: [],
      agentStatuses: [],
    })).toEqual([enabledProject]);
  });

  it("allows switching only while no recording, delivery, or playback is in flight", () => {
    expect(canSwitchVoiceProject("ready")).toBe(true);
    expect(canSwitchVoiceProject("thinking")).toBe(true);
    expect(canSwitchVoiceProject("offline")).toBe(true);
    expect(canSwitchVoiceProject("listening")).toBe(false);
    expect(canSwitchVoiceProject("transcribing")).toBe(false);
    expect(canSwitchVoiceProject("sending")).toBe(false);
    expect(canSwitchVoiceProject("speaking")).toBe(false);
  });

  it("resolves a different enabled target without falling through to another Project", () => {
    const first = fixtureProjects[0]!;
    const second = { ...first, id: "project-second", name: "Second" };
    const projects = [first, second];

    expect(switchableVoiceProject(projects, first.id, second.id, "ready")).toBe(second);
    expect(switchableVoiceProject(projects, first.id, first.id, "ready")).toBeUndefined();
    expect(switchableVoiceProject(projects, first.id, "disabled-project", "ready")).toBeUndefined();
    expect(switchableVoiceProject(projects, first.id, second.id, "speaking")).toBeUndefined();
  });
});
