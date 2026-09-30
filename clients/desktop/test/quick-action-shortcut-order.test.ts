import { describe, expect, it } from "vitest";
import { groupQuickActionShortcuts } from "../src/renderer/quick-action-shortcut-order.js";
import type { QuickActionShortcut } from "../src/renderer/quick-action-shortcuts.js";

function shortcut(agentId: string, model: string, reasoning: QuickActionShortcut["reasoning"] = "default"): QuickActionShortcut {
  return { id: `${agentId}:${model}:${reasoning}`, agentId, model, reasoning, name: model, icon: "agent", permission: "default" };
}

describe("Shortcut display order", () => {
  it.each([
    ["codex", ["default", "gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.5", "gpt-5.6-sol", "gpt-6-sol", "gpt-5.5-pro", "gpt-6-astra"]],
    ["claude", ["default", "haiku", "sonnet", "fable", "opus", "opus[1m]"]],
    ["gemini", ["default", "flash-lite", "flash", "pro"]],
    ["opencode", ["default", "openai/gpt-6-luna", "openai/gpt-6-sol", "openai/gpt-6-astra"]],
  ] as const)("sorts %s from smaller to larger named tiers", (agentId, models) => {
    const input = models.map((model) => shortcut(agentId, model)).reverse();
    expect(groupQuickActionShortcuts(input)[0]!.shortcuts.map((item) => item.model)).toEqual(models);
  });

  it("groups interleaved providers beside their existing buttons without mutating saved order", () => {
    const codex = shortcut("codex", "gpt-6-astra");
    const claude = shortcut("claude", "sonnet");
    const smaller = shortcut("codex", "gpt-6-luna");
    const missing = shortcut("other", "model-7b");
    const input = Object.freeze([codex, missing, claude, smaller]);
    expect(groupQuickActionShortcuts(input, ["claude", "codex", "gemini", "opencode"])).toEqual([
      { agentId: "claude", shortcuts: [claude] },
      { agentId: "codex", shortcuts: [smaller, codex] },
      { agentId: "gemini", shortcuts: [] },
      { agentId: "opencode", shortcuts: [] },
      { agentId: "other", shortcuts: [missing] },
    ]);
    expect(input).toEqual([codex, missing, claude, smaller]);
  });

  it("uses numeric name order for unknown model families, even without provider capabilities", () => {
    const input = ["provider/model-70b", "provider/model-10b", "provider/model-7b"].map((model) => shortcut("opencode", model));
    expect(groupQuickActionShortcuts(input)[0]!.shortcuts.map((item) => item.model)).toEqual([
      "provider/model-7b", "provider/model-10b", "provider/model-70b",
    ]);
  });

  it("orders the same model by reasoning and keeps equal selections stable", () => {
    const first = shortcut("codex", "gpt-6-sol", "high");
    const second = { ...first, id: "second", name: "Another color", icon: "star" as const };
    const input = [first, shortcut("codex", "gpt-6-sol", "max"), second, shortcut("codex", "gpt-6-sol", "low")];
    expect(groupQuickActionShortcuts(input)[0]!.shortcuts).toEqual([input[3], first, second, input[1]]);
  });
});
