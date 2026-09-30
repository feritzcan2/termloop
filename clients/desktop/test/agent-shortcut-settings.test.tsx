// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLaunchButton } from "../src/renderer/ui/AgentLaunchButton.js";
import { AgentShortcutSettings } from "../src/renderer/ui/AgentShortcutSettings.js";
import { QuickActionShortcutEditor } from "../src/renderer/ui/QuickActionShortcutEditor.js";
import { WorkspaceViewSwitch } from "../src/renderer/ui/WorkspaceViewSwitch.js";
import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { QuickActionShortcutLaunchers } from "../src/renderer/ui/QuickActionShortcutLaunchers.js";
import { fullAgentCapability, resumableOpenCodeCapability, observableGeminiCapability } from "./agent-capability-fixture.js";
import type { QuickActionShortcut } from "../src/renderer/quick-action-shortcuts.js";

const shortcut: QuickActionShortcut = { id: "one", name: "Review", agentId: "codex", model: "gpt-6-astra", permission: "plan", reasoning: "high", icon: "star" };
const capabilities = [fullAgentCapability("codex"), fullAgentCapability("claude"), resumableOpenCodeCapability(), observableGeminiCapability()];

describe("Agent shortcut configuration", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const pointer = async (button: HTMLButtonElement, type: string, x = 0) => act(async () => button.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x })));

  it("launches on short click and opens settings on hold without launching on release", async () => {
    vi.useFakeTimers(); const launch = vi.fn(); const configure = vi.fn();
    await act(async () => root.render(<AgentLaunchButton onClick={launch} configure={configure}>Codex</AgentLaunchButton>));
    const button = container.querySelector('button')!;
    await pointer(button, "pointerdown"); await pointer(button, "pointerup"); await act(async () => button.click());
    expect(launch).toHaveBeenCalledTimes(1);
    await pointer(button, "pointerdown"); await act(async () => vi.advanceTimersByTime(550));
    expect(configure).toHaveBeenCalledTimes(1);
    await pointer(button, "pointerup"); await act(async () => button.click());
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("cancels a hold on movement, leaving the button, cancellation or unmount", async () => {
    vi.useFakeTimers(); const configure = vi.fn(); const launch = vi.fn();
    await act(async () => root.render(<AgentLaunchButton onClick={launch} configure={configure}>Codex</AgentLaunchButton>));
    const button = container.querySelector('button')!;
    for (const event of ["pointermove", "pointerout", "pointercancel"]) {
      await pointer(button, "pointerdown"); await pointer(button, event, 20);
      await act(async () => vi.advanceTimersByTime(600));
      expect(configure).not.toHaveBeenCalled();
    }
    await pointer(button, "pointerdown"); await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTime(600)); expect(configure).not.toHaveBeenCalled();
  });

  it("offers right-click and keyboard configuration", async () => {
    const configure = vi.fn(); const launch = vi.fn();
    await act(async () => root.render(<AgentLaunchButton onClick={launch} configure={configure}>Codex</AgentLaunchButton>));
    const button = container.querySelector('button')!;
    await act(async () => button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
    expect(configure).toHaveBeenCalledTimes(2); expect(launch).not.toHaveBeenCalled();
  });

  it("opens configuration for every existing provider button and saved shortcut", async () => {
    const configure = vi.fn(); const launch = vi.fn();
    await act(async () => root.render(<WorkspaceViewSwitch view="agents" disabled={false} agents={capabilities} select={vi.fn()} launchTerminal={vi.fn()} launchAgent={launch} configureAgent={configure} />));
    for (const capability of capabilities) {
      const button = container.querySelector<HTMLButtonElement>(`button.${capability.agent_id}`)!;
      await act(async () => button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
      expect(configure).toHaveBeenLastCalledWith(capability.agent_id);
    }
    await act(async () => root.render(<QuickActionShortcutLaunchers shortcuts={[shortcut]} capabilities={capabilities} disabled={false} launch={launch} remove={vi.fn()} configure={configure} />));
    await act(async () => container.querySelector('.saved-agent-shortcut')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(configure).toHaveBeenLastCalledWith(shortcut); expect(launch).not.toHaveBeenCalled();
  });

  it("uses the selected provider logo for every color and updates the preview when switching providers", async () => {
    const shapes = new Set<string>();
    for (const agentId of ["codex", "claude", "opencode", "gemini"]) {
      await act(async () => root.render(<QuickActionShortcutEditor selection={{ ...shortcut, agentId }} disabled={false} save={vi.fn()} close={vi.fn()} />));
      const icons = [...container.querySelectorAll('.shortcut-icon-picker svg')];
      expect(icons).toHaveLength(12);
      expect(new Set(icons.map((icon) => icon.innerHTML)).size).toBe(1);
      expect(new Set(icons.map((icon) => icon.getAttribute("style"))).size).toBe(12);
      shapes.add(icons[0]!.innerHTML);
      expect(container.querySelector('.shortcut-preview svg')!.innerHTML).toBe(icons[0]!.innerHTML);
    }
    expect(shapes.size).toBe(4);
  });

  it("edits settings and color without launching or requiring a prompt", async () => {
    const save = vi.fn(); const close = vi.fn();
    await act(async () => root.render(<AgentShortcutSettings shortcut={shortcut} capabilities={capabilities} fixedProvider save={save} close={close} />));
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
    expect(model.value).toBe("gpt-6-astra");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!.disabled).toBe(true);
    await act(async () => { model.value = "gpt-6-luna"; model.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Mint"]')!.click());
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === "Save changes")!.click());
    expect(save).toHaveBeenCalledWith({ agentId: "codex", model: "gpt-6-luna", permission: "plan", reasoning: "high", name: "Review", icon: "terminal" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("shows OpenCode and its supported model settings in Quick Action", async () => {
    await act(async () => root.render(<QuickActionComposer projects={[]} selectedProject={undefined} capabilities={capabilities} profiles={[]} initialAgent="opencode" pasteImage={vi.fn()} restoreImage={vi.fn()} discardImage={vi.fn()} preview={vi.fn()} launch={vi.fn()} close={vi.fn()} />));
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!.value).toBe("opencode");
    expect(container.querySelector('option[value="opencode-go/kimi-k2.7-code"]')).not.toBeNull();
    expect([...container.querySelectorAll('select[aria-label="Permission"] option')].map((item) => item.getAttribute('value'))).toEqual(["default", "plan", "bypassPermissions"]);
  });
});
