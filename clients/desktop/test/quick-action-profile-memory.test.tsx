// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLibraryEntry } from "@termloop/contract/current";
import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { readQuickActionProfileSelection, rememberQuickActionProfileSelection } from "../src/renderer/quick-action-profile-memory.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

const finder: AgentLibraryEntry = {
  id: "builtin.agent-profile.scattered-orchestration-finder", name: "Scattered Orchestration Finder",
  description: "Find scattered orchestration", category: "Architecture", version: 3, permission: "bypassPermissions",
  read_only: false, user_invocable: true, agent_ids: ["claude", "codex"], instructions: "Find it.", source: "builtin",
  favorite: false, default_agent_id: "codex", default_model: "gpt-6-astra", default_reasoning: "xhigh",
};
const capabilities = [fullAgentCapability("claude"), fullAgentCapability("codex")];
const project = { id: "p", name: "Demo", folder_path: "/tmp/demo" };

function memoryStorage() {
  let value: string | null = null;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
}

describe("Quick Action per-profile selection memory", () => {
  it("keeps one bounded, validated selection per profile", () => {
    const storage = memoryStorage();
    rememberQuickActionProfileSelection(finder.id, { agentId: "claude", model: "opus[1m]", permission: "bypassPermissions", reasoning: "medium" }, storage);
    rememberQuickActionProfileSelection("builtin.agent-profile.edge-case-hunter", { agentId: "codex", model: "default", permission: "plan", reasoning: "high" }, storage);
    expect(readQuickActionProfileSelection(finder.id, storage)).toEqual({ agentId: "claude", model: "opus[1m]", permission: "bypassPermissions", reasoning: "medium" });
    expect(readQuickActionProfileSelection("builtin.agent-profile.edge-case-hunter", storage)?.agentId).toBe("codex");
    expect(readQuickActionProfileSelection("builtin.agent-profile.unknown", storage)).toBeUndefined();

    rememberQuickActionProfileSelection(finder.id, { agentId: "claude", model: "x", permission: "everything" as never, reasoning: "medium" }, storage);
    expect(readQuickActionProfileSelection(finder.id, storage)?.permission).toBe("bypassPermissions");

    for (let index = 0; index < 70; index += 1) {
      rememberQuickActionProfileSelection(`custom.agent-profile.p${index}`, { agentId: "codex", model: "default", permission: "plan", reasoning: "default" }, storage);
    }
    expect(readQuickActionProfileSelection(finder.id, storage)).toBeUndefined();
    expect(readQuickActionProfileSelection("custom.agent-profile.p69", storage)).toBeDefined();
  });

  it("ignores corrupt storage", () => {
    const storage = { getItem: () => "{not json", setItem: vi.fn() };
    expect(readQuickActionProfileSelection(finder.id, storage)).toBeUndefined();
  });
});

describe("Quick Action composer per-profile selection", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const selection = () => ({ provider: select("Provider").value, model: select("Model").value, permission: select("Permission").value, reasoning: select("Reasoning").value });
  const render = (props: Record<string, unknown>) => act(async () => root.render(createElement(QuickActionComposer, {
    projects: [project], selectedProject: project, capabilities, profiles: [finder], libraryProfiles: [finder],
    pasteImage: vi.fn(), restoreImage: vi.fn(), discardImage: vi.fn(), preview: vi.fn(), launch: vi.fn(), close: vi.fn(),
    ...props,
  })));

  it("uses the saved profile defaults until the profile has run", async () => {
    await render({ initialTemplateRef: finder.id });
    expect(selection()).toEqual({ provider: "codex", model: "gpt-6-astra", permission: "bypassPermissions", reasoning: "xhigh" });
  });

  it("reopens a profile with the selection it last ran with", async () => {
    rememberQuickActionProfileSelection(finder.id, { agentId: "claude", model: "opus[1m]", permission: "bypassPermissions", reasoning: "medium" });
    await render({ initialTemplateRef: finder.id });
    expect(selection()).toEqual({ provider: "claude", model: "opus[1m]", permission: "bypassPermissions", reasoning: "medium" });
  });

  it("restores the remembered selection when the profile is picked", async () => {
    rememberQuickActionProfileSelection(finder.id, { agentId: "claude", model: "opus[1m]", permission: "acceptEdits", reasoning: "medium" });
    await render({ initialAgent: "codex" });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Agent profile"]')!.click());
    const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.includes(finder.name))!;
    await act(async () => option.click());
    expect(selection()).toEqual({ provider: "claude", model: "opus[1m]", permission: "acceptEdits", reasoning: "medium" });
  });

  it("remembers the profile's selection only after a successful launch", async () => {
    const preview = vi.fn().mockResolvedValue({ launch_ticket: "ticket", manifest: { digest: "sha256:test" } });
    const launch = vi.fn().mockResolvedValueOnce("launch failed").mockResolvedValue(undefined);
    await render({ initialTemplateRef: finder.id, preview, launch });
    await act(async () => {
      const prompt = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "bul sorunları");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const provider = select("Provider");
      provider.value = "claude";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      const model = select("Model");
      model.value = "opus[1m]";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const submit = () => act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await submit();
    expect(launch).toHaveBeenCalledOnce();
    expect(readQuickActionProfileSelection(finder.id)).toBeUndefined();
    await submit();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(readQuickActionProfileSelection(finder.id)).toMatchObject({ agentId: "claude", model: "opus[1m]" });
  });
});
