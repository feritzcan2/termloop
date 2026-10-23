import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TERMINAL_PREFERENCES,
  MAX_CUSTOM_KEYS,
  createTerminalPreferencesStore,
  parseTerminalPreferences,
  quickCommandTitle,
} from "../src/features/terminal/terminal-preferences-store";

describe("terminal preferences", () => {
  it("defaults to 13pt text and autocorrect off", () => {
    expect(parseTerminalPreferences(null)).toEqual(DEFAULT_TERMINAL_PREFERENCES);
    expect(DEFAULT_TERMINAL_PREFERENCES.autocorrect).toBe(false);
    expect(DEFAULT_TERMINAL_PREFERENCES.textSizeIndex).toBe(2);
  });

  it("drops only the damaged entries of a stored set", () => {
    const parsed = parseTerminalPreferences(JSON.stringify({
      textSizeIndex: 99,
      autocorrect: true,
      customKeys: [
        { id: "a", label: "^R", sequence: "\\cR" },
        { id: "b", label: "bad", sequence: "\\q" },
        { id: "c", label: "", sequence: "x" },
        "junk",
      ],
      quickCommands: [
        { id: "q", label: "", body: "pnpm test", enter: true },
        { id: "r", label: "empty", body: "", enter: true },
        { id: "s", label: "no flag", body: "ls" },
      ],
    }));
    expect(parsed.textSizeIndex).toBe(5);
    expect(parsed.autocorrect).toBe(true);
    expect(parsed.customKeys.map(({ id }) => id)).toEqual(["a"]);
    expect(parsed.quickCommands.map(({ id }) => id)).toEqual(["q"]);
  });

  it.each(["{", "[]", "null", "\"text\""])("falls back to defaults for %s", (stored) => {
    expect(parseTerminalPreferences(stored)).toEqual(DEFAULT_TERMINAL_PREFERENCES);
  });

  it("restores what was saved and persists edits in order", async () => {
    let saved: string | null = null;
    const store = createTerminalPreferencesStore({ read: async () => saved, write: async (value) => { saved = value; } });
    await store.initialize();
    await store.setTextSizeIndex(4);
    await store.saveCustomKey({ id: "k", label: "^R", sequence: "\\cR" });
    await store.saveQuickCommand({ id: "c", label: "Tests", body: "pnpm test", enter: false });
    await store.saveQuickCommand({ id: "c", label: "Tests", body: "pnpm test --watch", enter: true });
    const restored = createTerminalPreferencesStore({ read: async () => saved, write: vi.fn() });
    await restored.initialize();
    expect(restored.get().textSizeIndex).toBe(4);
    expect(restored.get().customKeys).toEqual([{ id: "k", label: "^R", sequence: "\\cR" }]);
    expect(restored.get().quickCommands).toEqual([{ id: "c", label: "Tests", body: "pnpm test --watch", enter: true }]);
    await restored.removeQuickCommand("c");
    expect(restored.get().quickCommands).toEqual([]);
  });

  it("keeps an edit made while storage was still loading", async () => {
    let finish: ((value: string | null) => void) | undefined;
    const store = createTerminalPreferencesStore({
      read: () => new Promise((resolve) => { finish = resolve; }),
      write: vi.fn(async () => {}),
    });
    const listener = vi.fn();
    store.subscribe(listener);
    const loading = store.initialize();
    await store.setAutocorrect(true);
    finish!(JSON.stringify({ autocorrect: false, textSizeIndex: 0 }));
    await loading;
    expect(store.get().autocorrect).toBe(true);
    expect(listener).toHaveBeenCalled();
  });

  it("starts on defaults when storage cannot be read", async () => {
    const store = createTerminalPreferencesStore({ read: async () => { throw new Error("locked"); }, write: vi.fn() });
    await store.initialize();
    expect(store.get()).toEqual(DEFAULT_TERMINAL_PREFERENCES);
  });

  it("refuses invalid keys and keys past the cap", async () => {
    const write = vi.fn(async () => {});
    const store = createTerminalPreferencesStore({ read: async () => null, write });
    await store.initialize();
    await store.saveCustomKey({ id: "bad", label: "x", sequence: "\\" });
    expect(store.get().customKeys).toEqual([]);
    for (let index = 0; index < MAX_CUSTOM_KEYS + 2; index += 1) {
      await store.saveCustomKey({ id: `k${index}`, label: `k${index}`, sequence: "x" });
    }
    expect(store.get().customKeys).toHaveLength(MAX_CUSTOM_KEYS);
  });

  it("names an unnamed command by its first line", () => {
    expect(quickCommandTitle({ id: "a", label: "", body: "git status\ngit diff", enter: true })).toBe("git status");
    expect(quickCommandTitle({ id: "a", label: " Deploy ", body: "x", enter: true })).toBe("Deploy");
  });
});

it("does not rewrite storage for an unchanged size or autocorrect choice", async () => {
  const write = vi.fn(async () => {});
  const store = createTerminalPreferencesStore({ read: async () => null, write });
  await store.initialize();
  await store.setTextSizeIndex(99);
  await store.setTextSizeIndex(99);
  await store.setAutocorrect(false);
  expect(write).toHaveBeenCalledTimes(1);
  expect(store.get().textSizeIndex).toBe(5);
});
