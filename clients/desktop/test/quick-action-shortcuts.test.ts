import { describe, expect, it } from "vitest";
import {
  MAX_QUICK_ACTION_SHORTCUTS, quickActionShortcutUnavailable, readQuickActionShortcuts,
  removeQuickActionShortcut, saveQuickActionShortcut, type QuickActionShortcutDraft,
  readProviderShortcuts, saveProviderShortcut, updateQuickActionShortcut,
} from "../src/renderer/quick-action-shortcuts.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

const draft: QuickActionShortcutDraft = { name: "Deep review", icon: "search", agentId: "codex", model: "gpt-6-astra", permission: "plan", reasoning: "high" };
const storage = (initial: string | null = null) => {
  let value = initial;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
};

describe("Quick Action shortcuts", () => {
  it("persists independent model selections and removes only the chosen shortcut", () => {
    const source = storage();
    const first = saveQuickActionShortcut({ ...draft, name: "  Deep review  " }, source)[0]!;
    const next = saveQuickActionShortcut({ ...draft, model: "gpt-6-luna", reasoning: "low" }, source);
    expect(readQuickActionShortcuts(source)).toEqual(next);
    expect(next[0]).toEqual({ ...draft, id: first.id });
    expect(next[1]?.id).not.toBe(first.id);
    expect(removeQuickActionShortcut(first.id, source)).toEqual([next[1]]);
    expect(readQuickActionShortcuts(source)).toEqual([next[1]]);
  });

  it("saves only model settings and presentation, without prompts, accounts or project targets", () => {
    const source = storage();
    saveQuickActionShortcut({ ...draft, prompt: "private draft", projectId: "old-project", accountId: "old-account" } as QuickActionShortcutDraft, source);
    expect(JSON.parse(source.getItem()!)[0]).toEqual({ ...draft, id: expect.any(String) });
  });

  it("ignores malformed storage, invalid options and duplicate identities", () => {
    for (const raw of ["{", "null", "{}", "[]", "x".repeat(32_769)]) expect(readQuickActionShortcuts(storage(raw))).toEqual([]);
    const good = { ...draft, id: "one" };
    const candidates = [null, good, good, { ...good, id: "two", icon: "unknown" }, { ...good, id: "three", permission: "unsafe" }, { ...good, id: "four", model: "bad\nmodel" }];
    expect(readQuickActionShortcuts(storage(JSON.stringify(candidates)))).toEqual([good]);
  });

  it("caps saved shortcuts and rejects invalid drafts", () => {
    const source = storage();
    expect(() => saveQuickActionShortcut({ ...draft, name: "   " }, source)).toThrow("Choose a name");
    for (let i = 0; i < MAX_QUICK_ACTION_SHORTCUTS; i++) saveQuickActionShortcut(draft, source);
    expect(() => saveQuickActionShortcut(draft, source)).toThrow("maximum 12");
    expect(readQuickActionShortcuts(source)).toHaveLength(MAX_QUICK_ACTION_SHORTCUTS);
  });

  it("surfaces failed writes without reporting an unsaved shortcut", () => {
    const source = { getItem: () => null, setItem: () => { throw new Error("Storage full"); } };
    expect(() => saveQuickActionShortcut(draft, source)).toThrow("Storage full");
    expect(readQuickActionShortcuts(source)).toEqual([]);
    expect(readQuickActionShortcuts({ getItem: () => { throw new Error("Blocked"); } })).toEqual([]);
  });

  it("checks every saved selection against the current connection without fallback", () => {
    const capability = fullAgentCapability("codex");
    expect(quickActionShortcutUnavailable(draft, [capability])).toBeUndefined();
    expect(quickActionShortcutUnavailable(draft, [])).toContain("Provider");
    expect(quickActionShortcutUnavailable(draft, [{ ...capability, available: false }])).toContain("Provider");
    expect(quickActionShortcutUnavailable(draft, [{ ...capability, quick_action_supported: false }])).toBeUndefined();
    expect(quickActionShortcutUnavailable(draft, [{ ...capability, models: ["default"] }])).toContain("Model");
    expect(quickActionShortcutUnavailable(draft, [{ ...capability, permissions: ["default"] }])).toContain("Permission");
    expect(quickActionShortcutUnavailable(draft, [{ ...capability, reasoning: ["default"] }])).toContain("Reasoning");
  });

  it("updates a shortcut in place even when all twelve slots are used", () => {
    const source = storage();
    for (let i = 0; i < MAX_QUICK_ACTION_SHORTCUTS; i++) saveQuickActionShortcut(draft, source);
    const before = readQuickActionShortcuts(source);
    const changed = updateQuickActionShortcut(before[0]!.id, { ...draft, icon: "branch", model: "gpt-6-luna", name: "Fast review" }, source);
    expect(changed).toHaveLength(MAX_QUICK_ACTION_SHORTCUTS);
    expect(changed[0]).toMatchObject({ id: before[0]!.id, model: "gpt-6-luna", icon: "branch", name: "Fast review" });
    expect(changed.slice(1)).toEqual(before.slice(1));
    expect(() => updateQuickActionShortcut("missing", draft, source)).toThrow("no longer exists");
  });

  it("persists provider button settings independently from custom shortcuts", () => {
    const values = new Map<string, string>();
    const source = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const custom = saveQuickActionShortcut(draft, source);
    saveProviderShortcut(draft, source);
    saveProviderShortcut({ ...draft, model: "gpt-6-luna", icon: "terminal" }, source);
    expect(readProviderShortcuts(source)).toEqual([{ ...draft, id: "codex", model: "gpt-6-luna", icon: "terminal" }]);
    expect(readQuickActionShortcuts(source)).toEqual(custom);
  });
});
