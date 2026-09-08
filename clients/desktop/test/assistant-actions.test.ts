import { describe, expect, it, vi } from "vitest";

import { createAssistantActions } from "../src/renderer/composition/assistant-actions.js";
import { AssistantReadCoordinator } from "../src/renderer/composition/assistant-read-coordinator.js";
import type { SourceDesktopApi } from "../src/renderer/transport/desktop-api.js";
import { withCurrentRevision } from "../src/renderer/ui/StewardPanel.js";

describe("assistant composition actions", () => {
  it("recovers a Steward toggle from a cached revision without an invalidation event", async () => {
    let stateRevision = 7;
    const stewardConfigurationGet = vi.fn(async () => ({
      configuration: null,
      presence: { lastActivityAtEpochMs: null, activeCommandLabel: null, pendingProposal: false },
      stateRevision,
    }));
    const stewardConfigurationSet = vi.fn(async (params: { expectedRevision: number }) => {
      if (params.expectedRevision !== stateRevision) {
        throw new Error("Error invoking remote method 'termloop:steward-configuration-set': "
          + "TermLoopControlError: state revision changed; refresh and try again");
      }
      return { stateRevision: ++stateRevision };
    });
    const actions = createAssistantActions({
      api: { stewardConfigurationGet, stewardConfigurationSet } as unknown as SourceDesktopApi,
      coordinator: new AssistantReadCoordinator(),
      identity: { profileId: "remote-a", projectId: "project-a" },
      projectId: "project-a",
      promptImprovement: undefined,
      sessions: () => [],
    });
    const rendered = await actions.getConfiguration();
    // Another daemon write moves the global revision before its event reaches the UI.
    stateRevision = 12;
    const saved = await withCurrentRevision(
      rendered.stateRevision,
      async () => (await actions.getConfiguration()).stateRevision,
      (expectedRevision) => actions.setConfiguration(
        "codex", "default", "default", "default", true, "", expectedRevision,
      ),
    );

    expect(saved.stateRevision).toBe(13);
    expect(stewardConfigurationSet.mock.calls.map(([params]) => params.expectedRevision)).toEqual([7, 12]);
    expect(stewardConfigurationGet).toHaveBeenCalledTimes(2);
    await expect(actions.getConfiguration()).resolves.toMatchObject({ stateRevision: 13 });
    expect(stewardConfigurationGet).toHaveBeenCalledTimes(3);
  });

  it("shares projection reads, keeps presence live, and invalidates after writes", async () => {
    const stewardConfigurationGet = vi.fn(async () => ({
      configuration: null,
      presence: {
        lastActivityAtEpochMs: null,
        activeCommandLabel: null,
        pendingProposal: false,
      },
      stateRevision: 1,
    }) as never);
    const stewardConfigurationSet = vi.fn(async () => ({ stateRevision: 2 }) as never);
    const api = {
      stewardConfigurationGet,
      stewardConfigurationSet,
    } as unknown as SourceDesktopApi;
    const actions = createAssistantActions({
      api,
      coordinator: new AssistantReadCoordinator(),
      identity: { profileId: "remote-a", projectId: "project-a" },
      projectId: "project-a",
      promptImprovement: undefined,
      sessions: () => [],
    });

    await Promise.all([
      actions.getConfiguration(),
      actions.getConfiguration(),
      actions.getConfiguration(),
    ]);
    expect(stewardConfigurationGet).toHaveBeenCalledTimes(1);

    await actions.getPresence();
    expect(stewardConfigurationGet).toHaveBeenCalledTimes(2);

    await actions.setConfiguration(
      "codex",
      "default",
      "default",
      "default",
      true,
      "",
      1,
    );
    await actions.getConfiguration();
    expect(stewardConfigurationSet).toHaveBeenCalledTimes(1);
    expect(stewardConfigurationGet).toHaveBeenCalledTimes(3);
  });
});
