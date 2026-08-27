// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSetupDialog } from "../src/renderer/ui/AgentSetupDialog.js";
import { readQuickActionMemory, rememberQuickActionDraft } from "../src/renderer/quick-action-memory.js";
import { fullAgentCapability, launchOnlyGeminiCapability } from "./agent-capability-fixture.js";

const PROJECT = { id: "project-1", name: "TermLoop", folder_path: "/tmp/termloop" };

describe("Agent Setup", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("is a dedicated promptless surface and starts with the selected fallback settings", async () => {
    const start = vi.fn(async () => undefined);
    const close = vi.fn();
    rememberQuickActionDraft("keep this draft");
    await act(async () => root.render(createElement(AgentSetupDialog, {
      project: PROJECT,
      title: "Build Playbook with agent",
      capabilities: [launchOnlyGeminiCapability(), fullAgentCapability("codex")],
      start,
      close,
    })));

    expect(host.querySelector(".agent-setup-dialog")).not.toBeNull();
    expect(host.querySelector(".quick-action")).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("resumes this improver first");
    expect(["Agent", "Model", "Permission", "Reasoning"].map((label) =>
      host.querySelector(`select[aria-label="${label}"]`) !== null)).toEqual([true, true, true, true]);
    expect([...host.querySelectorAll('select[aria-label="Agent"] option')].map((option) => option.textContent))
      .toEqual(["codex"]);

    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());

    expect(start).toHaveBeenCalledWith({
      agentId: "codex",
      model: "default",
      permission: "default",
      reasoning: "default",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(readQuickActionMemory().draft).toBe("keep this draft");
  });

  it("opens an unconfigured Claude in auto permission mode", async () => {
    const start = vi.fn(async () => undefined);
    const close = vi.fn();
    await act(async () => root.render(createElement(AgentSetupDialog, {
      project: PROJECT,
      title: "Build Playbook with agent",
      capabilities: [fullAgentCapability("claude")],
      start,
      close,
    })));

    const permission = host.querySelector<HTMLSelectElement>('select[aria-label="Permission"]')!;
    expect(permission.value).toBe("acceptEdits");
    expect([...permission.options].map((option) => option.textContent))
      .toEqual(["manual", "auto", "plan", "bypass"]);

    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());

    expect(start).toHaveBeenCalledWith({
      agentId: "claude",
      model: "default",
      permission: "acceptEdits",
      reasoning: "default",
    });
  });

  it("keeps configured launch settings even when the improver cannot open", async () => {
    const start = vi.fn(async () => "provider unavailable");
    const close = vi.fn();
    await act(async () => root.render(createElement(AgentSetupDialog, {
      project: PROJECT,
      title: "Build Playbook with agent",
      capabilities: [fullAgentCapability("codex")],
      start,
      close,
    })));

    const choose = async (label: string, value: string) => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await choose("Model", "gpt-5.6-luna");
    await choose("Permission", "bypassPermissions");
    await choose("Reasoning", "medium");
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());

    expect(start).toHaveBeenCalledWith({
      agentId: "codex",
      model: "gpt-5.6-luna",
      permission: "bypassPermissions",
      reasoning: "medium",
    });
    expect(readQuickActionMemory().presets.codex).toEqual({
      model: "gpt-5.6-luna",
      permission: "bypassPermissions",
      reasoning: "medium",
    });
    expect(host.textContent).toContain("provider unavailable");
    expect(close).not.toHaveBeenCalled();
  });

  it("starts fresh only through the explicit Start fresh action", async () => {
    const start = vi.fn(async () => undefined);
    const close = vi.fn();
    await act(async () => root.render(createElement(AgentSetupDialog, {
      project: PROJECT,
      title: "Build Playbook with agent",
      capabilities: [fullAgentCapability("codex")],
      start,
      close,
    })));

    const freshButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Start fresh");
    expect(freshButton).not.toBeUndefined();
    await act(async () => freshButton?.click());

    expect(start).toHaveBeenCalledWith({
      agentId: "codex",
      model: "default",
      permission: "default",
      reasoning: "default",
    }, { fresh: true });
    expect(close).toHaveBeenCalled();
  });
});
