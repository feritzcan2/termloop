// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { QuickActionShortcutLaunchers } from "../src/renderer/ui/QuickActionShortcutLaunchers.js";
import { WorkspaceViewSwitch } from "../src/renderer/ui/WorkspaceViewSwitch.js";
import { readQuickActionShortcuts, removeQuickActionShortcut, saveQuickActionShortcut } from "../src/renderer/quick-action-shortcuts.js";
import { readQuickActionMemory, rememberQuickActionDraft } from "../src/renderer/quick-action-memory.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

const capability = fullAgentCapability("codex");
const composerProps = () => ({
  projects: [{ id: "project-1", name: "TermLoop", folder_path: "/tmp/termloop" }],
  selectedProject: { id: "project-1", name: "TermLoop", folder_path: "/tmp/termloop" },
  capabilities: [capability], profiles: [],
  pasteImage: vi.fn(), restoreImage: vi.fn(), discardImage: vi.fn(), preview: vi.fn(), launch: vi.fn(), close: vi.fn(),
});

describe("Quick Action shortcut controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
  const click = async (text: string) => act(async () => button(text).click());
  const select = async (label: string, value: string) => act(async () => {
    const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
  });

  it("creates an icon beside the providers using the selected settings, survives remount, launches and removes it", async () => {
    const props = composerProps();
    const launch = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      const [shortcuts, setShortcuts] = useState(readQuickActionShortcuts);
      return <><WorkspaceViewSwitch view="agents" disabled={false} agents={[capability]} select={vi.fn()} launchTerminal={vi.fn()} launchAgent={vi.fn()}
        shortcutLaunchers={<QuickActionShortcutLaunchers shortcuts={shortcuts} capabilities={[capability]} disabled={false} launch={launch} remove={(id) => setShortcuts(removeQuickActionShortcut(id))} />} />
        <QuickActionComposer {...props} createShortcut={(draft) => setShortcuts(saveQuickActionShortcut(draft))} /></>;
    }
    await act(async () => root.render(<Harness />));
    await select("Model", "gpt-6-astra"); await select("Permission", "plan"); await select("Reasoning", "high");
    await click("Create shortcut");
    expect(container.querySelectorAll('.shortcut-icon-picker input')).toHaveLength(12);
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Coral"]')!.click());
    await click("Save shortcut");
    const saved = readQuickActionShortcuts()[0]!;
    expect(saved).toMatchObject({ icon: "search", agentId: "codex", model: "gpt-6-astra", permission: "plan", reasoning: "high" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Shortcut created");
    expect(props.launch).not.toHaveBeenCalled();
    expect(readQuickActionMemory().presets).toEqual({});
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<Harness />));
    const launcher = container.querySelector<HTMLButtonElement>('.workspace-session-launchers .saved-agent-shortcut')!;
    expect(launcher.title).toContain("gpt-6-astra · plan · high");
    await act(async () => launcher.click());
    expect(launch).toHaveBeenCalledWith(saved);
    await act(async () => container.querySelector<HTMLButtonElement>('.remove-agent-shortcut')!.click());
    expect(readQuickActionShortcuts()).toEqual([]);
    expect(container.querySelector('.saved-agent-shortcut')).toBeNull();
  });

  it("saves from the name field with Enter without running a prompt", async () => {
    rememberQuickActionDraft("Keep this request");
    const props = composerProps();
    const createShortcut = vi.fn();
    await act(async () => root.render(<QuickActionComposer {...props} createShortcut={createShortcut} />));
    await click("Create shortcut");
    const input = container.querySelector<HTMLInputElement>('.shortcut-name input')!;
    expect(document.activeElement).toBe(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(createShortcut).toHaveBeenCalledTimes(1);
    expect(props.launch).not.toHaveBeenCalled();
    expect(readQuickActionMemory().draft).toBe("Keep this request");
    expect(document.activeElement).toBe(button("Create shortcut"));
  });

  it("cancels the editor with Escape and keeps the composer open", async () => {
    const props = composerProps(); const createShortcut = vi.fn();
    await act(async () => root.render(<QuickActionComposer {...props} createShortcut={createShortcut} />));
    await click("Create shortcut");
    await act(async () => container.querySelector('input[type="text"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('.quick-action-shortcut-editor')).toBeNull();
    expect(createShortcut).not.toHaveBeenCalled(); expect(props.close).not.toHaveBeenCalled();
  });

  it("keeps a failed save editable and never announces success", async () => {
    await act(async () => root.render(<QuickActionComposer {...composerProps()} createShortcut={() => { throw new Error("Storage full"); }} />));
    await click("Create shortcut"); await click("Save shortcut");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Storage full");
    expect(container.querySelector('.shortcut-created')).toBeNull();
    expect(container.querySelector('.quick-action-shortcut-editor')).not.toBeNull();
  });

  it("disables unavailable model shortcuts and offline launches while keeping removal available", async () => {
    const shortcuts = saveQuickActionShortcut({ name: "Astra", icon: "star", agentId: "codex", model: "gpt-6-astra", permission: "plan", reasoning: "high" });
    const launch = vi.fn(); const remove = vi.fn();
    for (const props of [{ capabilities: [capability], disabled: true }, { capabilities: [{ ...capability, models: ["default"] }], disabled: false }]) {
      await act(async () => root.render(<QuickActionShortcutLaunchers {...props} shortcuts={shortcuts} launch={launch} remove={remove} />));
      const launcher = container.querySelector<HTMLButtonElement>('.saved-agent-shortcut')!;
      expect(launcher.getAttribute("aria-disabled")).toBe("true");
      await act(async () => launcher.click()); expect(launch).not.toHaveBeenCalled();
      expect(container.querySelector<HTMLButtonElement>('.remove-agent-shortcut')!.disabled).toBe(false);
    }
  });
});
