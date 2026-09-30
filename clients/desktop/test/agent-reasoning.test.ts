import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { agentReasoningOptions } from "../src/renderer/agent-reasoning.js";
import { AgentShortcutSettings } from "../src/renderer/ui/AgentShortcutSettings.js";
import { fullAgentCapability, resumableOpenCodeCapability } from "./agent-capability-fixture.js";

describe("model reasoning", () => {
  it("uses the model catalog and supports older daemon capabilities", () => {
    const capability = resumableOpenCodeCapability();
    expect(agentReasoningOptions(capability, "default")).toEqual(["default"]);
    expect(agentReasoningOptions(capability, "opencode-go/kimi-k2.7-code")).toEqual(["default", "max"]);
    expect(agentReasoningOptions(capability, "opencode-go/glm-5.3-flash")).toEqual(["default", "low", "high", "max"]);
    expect(agentReasoningOptions(capability, "opencode-go/minimax-m3")).toEqual(["default", "none", "thinking"]);
    expect(agentReasoningOptions(capability, "opencode-go/qwen3.7-plus")).toEqual(["default"]);
    const codex = fullAgentCapability("codex");
    expect(agentReasoningOptions(codex, "gpt-6-astra")).toEqual(codex.reasoning);
  });

  it("renders only the selected OpenCode model's reasoning choices in launcher settings", () => {
    const markup = renderToStaticMarkup(createElement(AgentShortcutSettings, {
      shortcut: { name: "OpenCode", icon: "terminal", agentId: "opencode", model: "opencode-go/minimax-m3", permission: "default", reasoning: "thinking" },
      capabilities: [resumableOpenCodeCapability()], fixedProvider: true,
      save: vi.fn(), close: vi.fn(),
    }));
    const menu = markup.match(/<select aria-label="Reasoning"[^>]*>(.*?)<\/select>/)?.[1];
    expect(menu).toBeDefined();
    expect(menu).toContain('<option value="none">none</option>');
    expect(menu).toContain('<option value="thinking" selected="">thinking</option>');
    expect(menu).not.toContain('value="max"');
    expect(menu).not.toContain('value="high"');
  });
});
