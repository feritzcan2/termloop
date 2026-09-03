import { describe, expect, it, vi } from "vitest";

import { createAssistantActions } from "../src/renderer/composition/assistant-actions.js";
import { AssistantReadCoordinator } from "../src/renderer/composition/assistant-read-coordinator.js";
import type { SourceDesktopApi } from "../src/renderer/transport/desktop-api.js";

describe("assistant composition actions", () => {
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
