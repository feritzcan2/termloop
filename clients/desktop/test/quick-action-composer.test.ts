import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QUICK_ACTION_MODELS, QUICK_ACTION_PERMISSIONS, QUICK_ACTION_REASONING, QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { fullAgentCapability, launchOnlyGeminiCapability, observableGeminiCapability } from "./agent-capability-fixture.js";

describe("Quick Action composer", () => {
  it("renders Project, agent, model, prompt, preview, and launch controls", () => {
    const markup = renderToStaticMarkup(createElement(QuickActionComposer, {
      projects: [{ id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" }],
      selectedProject: { id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" },
      capabilities: [
        fullAgentCapability("claude"),
        fullAgentCapability("codex"),
        launchOnlyGeminiCapability(),
      ],
      pasteImage: vi.fn(), restoreImage: vi.fn(), discardImage: vi.fn(), preview: vi.fn(), launch: vi.fn(), close: vi.fn(),
    }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="Run in Project"');
    expect(markup).toContain('aria-label="Agent"');
    expect(markup).toContain('aria-label="Model"');
    expect(markup).toContain('aria-label="Permission"');
    expect(markup).toContain('aria-label="Reasoning"');
    expect(markup).toContain("Opus (1M context)");
    expect(markup).toContain("Fable");
    expect(markup).toContain("bypass");
    expect(markup).toContain("What would you like to run?");
    expect(markup).toContain("Advanced 0");
    expect(markup).toContain("⌘↵");
    expect(markup).toContain("Worktree");
    expect(markup).not.toContain("Gemini CLI");
  });

  it("offers every runtime-proven Quick Action provider and uses its own option catalog", () => {
    const markup = renderToStaticMarkup(createElement(QuickActionComposer, {
      projects: [{ id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" }],
      selectedProject: { id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" },
      capabilities: [observableGeminiCapability()],
      initialAgent: "gemini",
      pasteImage: vi.fn(), restoreImage: vi.fn(), discardImage: vi.fn(), preview: vi.fn(), launch: vi.fn(), close: vi.fn(),
    }));
    expect(markup).toContain('<option value="gemini" selected="">gemini</option>');
    expect(markup).toContain('<option value="flash-lite">flash-lite</option>');
    expect(markup).not.toContain('<option value="high">high</option>');
  });

  it("keeps provider model choices explicit", () => {
    expect(QUICK_ACTION_MODELS.claude).toEqual(["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"]);
    expect(QUICK_ACTION_MODELS.codex).toEqual([
      "default", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.5-pro",
    ]);
    expect(QUICK_ACTION_MODELS.gemini).toEqual(["default", "auto", "pro", "flash", "flash-lite"]);
    expect(QUICK_ACTION_PERMISSIONS).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(QUICK_ACTION_REASONING).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
  });
});
