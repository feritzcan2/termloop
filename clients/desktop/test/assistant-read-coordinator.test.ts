import { describe, expect, it, vi } from "vitest";

import {
  AssistantReadCoordinator,
  assistantInvalidationIncludesProjection,
  assistantInvalidationMatchesSelection,
} from "../src/renderer/composition/assistant-read-coordinator.js";

const IDENTITY = { profileId: "remote-a", projectId: "project-a" };

describe("assistant read coordinator", () => {
  it("shares one named read across every surface in one generation", async () => {
    const coordinator = new AssistantReadCoordinator();
    const load = vi.fn(async () => ({ stateRevision: 1 }));

    const [rail, pet, panel] = await Promise.all([
      coordinator.read(IDENTITY, "steward.configurationGet", load),
      coordinator.read(IDENTITY, "steward.configurationGet", load),
      coordinator.read(IDENTITY, "steward.configurationGet", load),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(rail).toBe(pet);
    expect(pet).toBe(panel);
  });

  it("bounds a mounted-surface burst to one request per named read", async () => {
    const coordinator = new AssistantReadCoordinator();
    const releases: Array<() => void> = [];
    let active = 0;
    let peakActive = 0;
    const load = vi.fn(async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return "loaded";
    });
    const readKeys = [
      "steward.configurationGet",
      "companion.transcriptList:latest",
      "worker.configurationList",
      "routine.configurationList",
      "routine.runtimeList",
      "playbook.get",
      "playbook.runtime",
    ];
    const reads = Array.from({ length: 21 }, (_, index) =>
      coordinator.read(IDENTITY, readKeys[index % readKeys.length]!, load));

    expect(load).toHaveBeenCalledTimes(readKeys.length);
    expect(peakActive).toBe(readKeys.length);
    for (const release of releases) release();
    await expect(Promise.all(reads)).resolves.toEqual(Array(21).fill("loaded"));
  });

  it("invalidates cached reads after a successful mutation", async () => {
    const coordinator = new AssistantReadCoordinator();
    const load = vi.fn()
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");
    const mutate = coordinator.wrapMutation(IDENTITY, vi.fn(async (enabled: boolean) => enabled));

    await expect(coordinator.read(IDENTITY, "steward.configurationGet", load)).resolves.toBe("before");
    await expect(mutate(true)).resolves.toBe(true);
    await expect(coordinator.read(IDENTITY, "steward.configurationGet", load)).resolves.toBe("after");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces invalidations received in flight into one trailing read", async () => {
    const coordinator = new AssistantReadCoordinator();
    const releases: Array<(value: number) => void> = [];
    const load = vi.fn(() => new Promise<number>((resolve) => releases.push(resolve)));

    const first = coordinator.read(IDENTITY, "playbook.get", load);
    coordinator.invalidate(IDENTITY);
    coordinator.invalidate(IDENTITY);
    const overlapping = coordinator.read(IDENTITY, "playbook.get", load);
    expect(load).toHaveBeenCalledTimes(1);

    releases.shift()?.(1);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    releases.shift()?.(2);

    await expect(first).resolves.toBe(2);
    await expect(overlapping).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("caches settled reads until their identity is invalidated", async () => {
    const coordinator = new AssistantReadCoordinator();
    const load = vi.fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    await expect(coordinator.read(IDENTITY, "routine.configurationList", load)).resolves.toBe("first");
    await expect(coordinator.read(IDENTITY, "routine.configurationList", load)).resolves.toBe("first");
    coordinator.invalidate(IDENTITY);
    await expect(coordinator.read(IDENTITY, "routine.configurationList", load)).resolves.toBe("second");

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("marks cached Projects stale by computer without waking a reader", async () => {
    const coordinator = new AssistantReadCoordinator();
    const remoteLoad = vi.fn()
      .mockResolvedValueOnce("remote-first")
      .mockResolvedValueOnce("remote-second");
    const localLoad = vi.fn(async () => "local");
    const localIdentity = { profileId: "local", projectId: "project-local" };

    await coordinator.read(IDENTITY, "playbook.get", remoteLoad);
    await coordinator.read(localIdentity, "playbook.get", localLoad);
    coordinator.invalidateProfile("remote-a");

    await expect(coordinator.read(localIdentity, "playbook.get", localLoad)).resolves.toBe("local");
    await expect(coordinator.read(IDENTITY, "playbook.get", remoteLoad)).resolves.toBe("remote-second");
    expect(localLoad).toHaveBeenCalledTimes(1);
    expect(remoteLoad).toHaveBeenCalledTimes(2);
  });

  it("routes assistant invalidations only from the selected computer", () => {
    expect(assistantInvalidationIncludesProjection(["agentStatus"])).toBe(true);
    expect(assistantInvalidationIncludesProjection(["task"])).toBe(false);
    expect(assistantInvalidationMatchesSelection("remote-a", "remote-a", ["agentStatus"]))
      .toBe(true);
    expect(assistantInvalidationMatchesSelection("local", "remote-a", ["agentStatus", "steward"]))
      .toBe(false);
    expect(assistantInvalidationMatchesSelection("remote-a", "remote-a", ["task"]))
      .toBe(false);
  });
});
