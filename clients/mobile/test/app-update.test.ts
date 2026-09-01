import { describe, expect, it, vi } from "vitest";

import {
  forceLatestAppUpdate,
  type AppUpdateClient,
  type AppUpdatePhase,
} from "../src/platform/app-update";

function client(overrides: Partial<AppUpdateClient> = {}): AppUpdateClient {
  return {
    enabled: true,
    fetch: vi.fn().mockResolvedValue({ isNew: true, isRollBackToEmbedded: false }),
    reload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("force app update", () => {
  it("downloads and reloads the newest compatible OTA", async () => {
    const phases: AppUpdatePhase[] = [];
    const updates = client();

    await expect(forceLatestAppUpdate({ client: updates, onPhase: (phase) => phases.push(phase) }))
      .resolves.toBe("reloading");

    expect(phases).toEqual(["checking", "downloading", "reloading"]);
    expect(updates.fetch).toHaveBeenCalledOnce();
    expect(updates.reload).toHaveBeenCalledOnce();
  });

  it("applies a rollback directive from the update service", async () => {
    const updates = client({
      fetch: vi.fn().mockResolvedValue({ isNew: false, isRollBackToEmbedded: true }),
    });

    await expect(forceLatestAppUpdate({ client: updates })).resolves.toBe("reloading");

    expect(updates.fetch).toHaveBeenCalledOnce();
    expect(updates.reload).toHaveBeenCalledOnce();
  });

  it("reports a current or disabled build without reloading", async () => {
    const current = client({
      fetch: vi.fn().mockResolvedValue({ isNew: false, isRollBackToEmbedded: false }),
    });
    const disabled = client({ enabled: false });

    await expect(forceLatestAppUpdate({ client: current })).resolves.toBe("current");
    await expect(forceLatestAppUpdate({ client: disabled })).resolves.toBe("disabled");
    expect(current.fetch).toHaveBeenCalledOnce();
    expect(current.reload).not.toHaveBeenCalled();
    expect(disabled.fetch).not.toHaveBeenCalled();
  });
});
