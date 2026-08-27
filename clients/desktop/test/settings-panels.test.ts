// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpToolSettingsDto, McpToolSettingsResult } from "@termloop/contract/current";
import type { PromptAsset } from "../src/renderer/prompt-settings.js";
import { McpToolPanel } from "../src/renderer/ui/McpToolPanel.js";
import { PromptPanel } from "../src/renderer/ui/PromptPanel.js";

const tool: McpToolSettingsDto = {
  name: "ask_to",
  title: "Ask another agent",
  canonicalDescription: "Canonical Ask-To description",
  effectiveDescription: "Ask another agent for help.",
  customized: false,
  roles: ["interactive"],
};

const prompt: PromptAsset = {
  id: "builtin.agent.interactive",
  title: "Interactive agent",
  category: "Agent",
  version: 7,
  canonicalBody: "Canonical body",
  effectiveBody: "Effective body",
  customized: true,
  source: "builtIn",
};

function type(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".stage-editor-source");
  if (!textarea) throw new Error("editor missing");
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setValue?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Settings stage pages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const save = () => container.querySelector<HTMLButtonElement>(".primary-button");

  it("saves an MCP description with the revision the rail was loaded with", async () => {
    const updated: McpToolSettingsResult = { stateRevision: 8, tools: [{ ...tool, effectiveDescription: "Ask sparingly.", customized: true }] };
    const update = vi.fn().mockResolvedValue({ ok: true, result: updated });
    const apply = vi.fn();
    await act(async () => root.render(createElement(McpToolPanel, {
      tool, stateRevision: 7, update, reset: vi.fn(), apply, close: vi.fn(),
    })));

    expect(container.querySelector(".stage-editor-title h2")?.textContent).toBe("Ask another agent");
    expect(container.querySelector(".stage-editor-chip")?.textContent).toBe("Interactive");
    expect(save()?.disabled).toBe(true);

    await act(async () => type(container, "Ask sparingly."));
    expect(save()?.disabled).toBe(false);
    await act(async () => save()?.click());

    expect(update).toHaveBeenCalledWith({ tool: "ask_to", description: "Ask sparingly.", expectedRevision: 7 });
    expect(apply).toHaveBeenCalledWith(updated);
  });

  it("keeps an MCP conflict visible instead of overwriting another client", async () => {
    const update = vi.fn().mockResolvedValue({ ok: false, code: "conflict", details: undefined, message: "conflict" });
    await act(async () => root.render(createElement(McpToolPanel, {
      tool, stateRevision: 7, update, reset: vi.fn(), apply: vi.fn(), close: vi.fn(),
    })));

    await act(async () => type(container, "Ask sparingly."));
    await act(async () => save()?.click());

    expect(container.querySelector(".settings-rail-error")?.textContent).toContain("changed in another client");
  });

  it("refuses an empty MCP description without calling the daemon", async () => {
    const update = vi.fn();
    await act(async () => root.render(createElement(McpToolPanel, {
      tool, stateRevision: 7, update, reset: vi.fn(), apply: vi.fn(), close: vi.fn(),
    })));

    await act(async () => type(container, "   "));
    expect(save()?.disabled).toBe(true);
    expect(container.querySelector(".stage-editor-meta .form-error")?.textContent).toContain("empty");
    expect(update).not.toHaveBeenCalled();
  });

  it("saves and resets a customized prompt", async () => {
    const update = vi.fn().mockResolvedValue([{ ...prompt, effectiveBody: "New body" }]);
    const reset = vi.fn().mockResolvedValue([{ ...prompt, effectiveBody: "Canonical body", customized: false }]);
    const apply = vi.fn();
    await act(async () => root.render(createElement(PromptPanel, {
      prompt, update, reset, apply, close: vi.fn(),
    })));

    expect(container.querySelector(".stage-editor-title span")?.textContent).toBe("Agent · v7");
    await act(async () => type(container, "New body"));
    await act(async () => save()?.click());
    expect(update).toHaveBeenCalledWith("builtin.agent.interactive", "New body");
    expect(apply).toHaveBeenCalledWith([{ ...prompt, effectiveBody: "New body" }]);

    await act(async () => container.querySelector<HTMLButtonElement>(".secondary-button")?.click());
    expect(reset).toHaveBeenCalledWith("builtin.agent.interactive");
  });

  it("shows a runtime projection read only", async () => {
    await act(async () => root.render(createElement(PromptPanel, {
      prompt: { ...prompt, id: "runtime.steward.protected", customized: false, editable: false, source: "project" },
      update: vi.fn(), reset: vi.fn(), apply: vi.fn(), close: vi.fn(),
    })));

    expect(container.querySelector(".stage-editor-readonly")?.textContent).toBe("Read only");
    expect(container.querySelector<HTMLTextAreaElement>(".stage-editor-source")?.readOnly).toBe(true);
    expect(save()?.disabled).toBe(true);
  });
});
