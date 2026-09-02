import { describe, expect, it } from "vitest";

import {
  canSwitchVoiceProject,
  enabledVoiceTargets,
  switchableVoiceTarget,
} from "../src/presentation/steward-voice-project-selection";
import { fixtureProjects } from "../src/fixtures/mobile-overview";

describe("Steward voice project selection", () => {
  it("offers only Projects whose Steward configuration is enabled", () => {
    const enabledProject = fixtureProjects[0]!;
    const targets = enabledVoiceTargets([{
      connectionId: "mac-home",
      connectionName: "Home Mac",
      overview: {
        projects: fixtureProjects,
        stewardEnabledProjectIds: [enabledProject.id],
        stewardExecutorSessionIds: {},
        tasks: [],
        sessions: [],
        agentStatuses: [],
      },
    }]);
    expect(targets).toMatchObject([{
      connectionId: "mac-home",
      connectionName: "Home Mac",
      projectId: enabledProject.id,
      projectName: enabledProject.name,
    }]);
  });

  it("allows switching only before a recording or after a recoverable error", () => {
    expect(canSwitchVoiceProject("ready")).toBe(true);
    expect(canSwitchVoiceProject("error")).toBe(true);
    expect(canSwitchVoiceProject("listening")).toBe(false);
    expect(canSwitchVoiceProject("transcribing")).toBe(false);
    expect(canSwitchVoiceProject("sending")).toBe(false);
    expect(canSwitchVoiceProject("sent")).toBe(false);
  });

  it("keeps same-named Projects on different Macs as distinct selectable targets", () => {
    const project = fixtureProjects[0]!;
    const overview = {
      projects: [project],
      stewardEnabledProjectIds: [project.id],
      stewardExecutorSessionIds: {},
      tasks: [],
      sessions: [],
      agentStatuses: [],
    };
    const targets = enabledVoiceTargets([
      { connectionId: "mac-home", connectionName: "Home Mac", overview },
      { connectionId: "mac-office", connectionName: "Office Mac", overview },
    ]);

    expect(targets.map((target) => [target.projectName, target.connectionName])).toEqual([
      [project.name, "Home Mac"],
      [project.name, "Office Mac"],
    ]);
    expect(targets[0]?.id).not.toBe(targets[1]?.id);
    expect(switchableVoiceTarget(targets, targets[0]?.id, targets[1]!.id, "ready")).toBe(targets[1]);
    expect(switchableVoiceTarget(targets, targets[0]?.id, "missing", "ready")).toBeUndefined();
    expect(switchableVoiceTarget(targets, targets[0]?.id, targets[1]!.id, "sending")).toBeUndefined();
  });
});
