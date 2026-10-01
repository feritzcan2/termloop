import { describe, expect, it, vi } from "vitest";

import { createAppearanceStore } from "../../src/theme/appearance-store";

describe("appearance preference", () => {
  it.each(["light", "dark"] as const)("restores saved %s mode", async (mode) => {
    const store = createAppearanceStore({ read: async () => mode, write: vi.fn() });
    expect(store.isReady()).toBe(false);
    await store.initialize();
    expect(store.getMode()).toBe(mode);
    expect(store.isReady()).toBe(true);
  });

  it.each([null, "system", "broken"])("keeps the existing light appearance for %s", async (stored) => {
    const store = createAppearanceStore({ read: async () => stored, write: vi.fn() });
    await store.initialize();
    expect(store.getMode()).toBe("light");
    expect(store.isReady()).toBe(true);
  });

  it("starts even when storage cannot be read", async () => {
    const store = createAppearanceStore({ read: async () => { throw new Error("unavailable"); }, write: vi.fn() });
    await store.initialize();
    expect(store.getMode()).toBe("light");
    expect(store.isReady()).toBe(true);
  });

  it("publishes immediately, persists in order, and restores the final selection", async () => {
    let saved: string | null = null;
    let finishFirst: (() => void) | undefined;
    const preferences = {
      read: async () => saved,
      write: vi.fn(async (mode: string) => {
        if (mode === "dark") await new Promise<void>((resolve) => { finishFirst = resolve; });
        saved = mode;
      }),
    };
    const store = createAppearanceStore(preferences);
    await store.initialize();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.setMode("dark");
    expect(store.getMode()).toBe("dark");
    expect(listener).toHaveBeenCalledOnce();
    const last = store.setMode("light");
    await Promise.resolve();
    expect(preferences.write.mock.calls).toEqual([["dark"]]);
    finishFirst!();
    await Promise.all([first, last]);
    expect(preferences.write.mock.calls).toEqual([["dark"], ["light"]]);
    const restarted = createAppearanceStore(preferences);
    await restarted.initialize();
    expect(restarted.getMode()).toBe("light");
    unsubscribe();
    listener.mockClear();
    await store.setMode("light");
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not replace a recent choice with a late storage read", async () => {
    let finishRead: (value: string) => void = () => {};
    const store = createAppearanceStore({
      read: () => new Promise<string>((resolve) => { finishRead = resolve; }), write: vi.fn(),
    });
    const initializing = store.initialize();
    await store.setMode("dark");
    finishRead("light");
    await initializing;
    expect(store.getMode()).toBe("dark");
  });

  it("keeps switching and retries persistence after a failed write", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
    const store = createAppearanceStore({ read: async () => null, write });
    await store.setMode("dark");
    expect(store.getMode()).toBe("dark");
    await store.setMode("light");
    expect(write).toHaveBeenLastCalledWith("light");
  });
});
