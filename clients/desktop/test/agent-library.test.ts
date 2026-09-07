// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLibraryEntry } from "@termloop/contract/current";
import { agentDraft, agentGroups, type AgentLibraryController } from "../src/renderer/agent-library.js";
import { AgentProfilePanel } from "../src/renderer/ui/AgentProfilePanel.js";
import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { useAgentLibrary } from "../src/renderer/composition/use-agent-library.js";
import type { SourceDesktopApi } from "../src/renderer/transport/desktop-api.js";
import { rememberQuickActionDraft } from "../src/renderer/quick-action-memory.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

const profile: AgentLibraryEntry = {
  id: "custom.agent-profile.reviewer", name: "Release reviewer", description: "Check release behavior", category: "Quality",
  version: 1, permission: "plan", read_only: true, user_invocable: true, agent_ids: ["claude", "codex"],
  instructions: "Inspect changes and return findings.", source: "personal", favorite: true,
  default_agent_id: "claude", default_model: "sonnet", default_reasoning: "high",
};
const capabilities = [fullAgentCapability("claude"), fullAgentCapability("codex")];

describe("agent library workflows", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;

  it("groups favorites once and searches descriptions", () => {
    expect(agentGroups([profile], "behavior").map((group) => group.profiles.length)).toEqual([1, 0, 0]);
    expect(agentDraft(profile, true)).toMatchObject({ name: "Release reviewer copy", instructions: profile.instructions, model: "sonnet" });
  });

  it("duplicates a built-in into a personal agent with its exact instructions and defaults", async () => {
    const create = vi.fn().mockResolvedValue(profile);
    const open = vi.fn();
    const library: AgentLibraryController = { value: { revision: 3, profiles: [profile] }, loading: false, error: undefined, reload: vi.fn(), create, update: vi.fn(), remove: vi.fn(), favorite: vi.fn() };
    await act(async () => root.render(createElement(AgentProfilePanel, { profile: { ...profile, source: "builtIn" }, duplicate: true, library, capabilities, canRun: true, open, copy: vi.fn(), run: vi.fn(), close: vi.fn() })));
    expect(container.querySelector("textarea")?.readOnly).toBe(false);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Release reviewer copy", instructions: profile.instructions, agentId: "claude", model: "sonnet", permission: "plan" }), 3);
    expect(open).toHaveBeenCalledWith(profile.id);
  });

  it("edits every built-in field in place and persists favorites through the named action", async () => {
    const favorite = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const builtin: AgentLibraryEntry = { ...profile, id: "builtin.agent-profile.edge-case-hunter", source: "builtIn" };
    const library: AgentLibraryController = { value: { revision: 7, profiles: [builtin] }, loading: false, error: undefined, reload: vi.fn(), create: vi.fn(), update, remove: vi.fn(), favorite };
    await act(async () => root.render(createElement(AgentProfilePanel, { profile: builtin, duplicate: false, library, capabilities, canRun: true, open: vi.fn(), copy: vi.fn(), run: vi.fn(), close: vi.fn() })));
    expect(container.querySelector("textarea")?.readOnly).toBe(false);
    expect(button("Save").disabled).toBe(true);
    expect([...container.querySelectorAll("input,select,textarea")].some((field) => (field as HTMLInputElement).disabled || (field as HTMLInputElement).readOnly)).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove agent from favorites"]')!.click());
    expect(favorite).toHaveBeenCalledWith(builtin.id, false, 7);
    for (const [label, value] of [
      ["Name", "My reviewer"], ["Category", "Release"], ["Description", "Review release behavior"],
      ["Provider", "codex"], ["Model", "gpt-5.6-sol"], ["Working mode", "acceptEdits"],
      ["Reasoning", "xhigh"], ["Instructions", "Inspect changes and implement improvements."],
    ]) {
      const field = [...container.querySelectorAll("label")].find((entry) => entry.firstChild?.textContent === label)!.querySelector("input,select,textarea")!;
      const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
      });
    }
    expect(button("Save").disabled).toBe(false);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(update).toHaveBeenCalledWith({ id: builtin.id, expectedRevision: 7, name: "My reviewer", category: "Release", description: "Review release behavior", agentId: "codex", model: "gpt-5.6-sol", permission: "acceptEdits", reasoning: "xhigh", instructions: "Inspect changes and implement improvements." });
    expect(library.create).not.toHaveBeenCalled();
  });

  it("loads profile defaults through the searchable picker and Escape closes only the picker", async () => {
    const close = vi.fn(); const manage = vi.fn();
    await act(async () => root.render(createElement(QuickActionComposer, {
      projects: [{ id: "p", name: "Demo", folder_path: "/tmp/demo" }], selectedProject: undefined, capabilities, profiles: [profile], libraryProfiles: [profile],
      initialAgent: "codex", manageAgents: manage,
      pasteImage: vi.fn(), restoreImage: vi.fn(), discardImage: vi.fn(), preview: vi.fn(), launch: vi.fn(), close,
    })));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Agent profile"]')!.click());
    expect(container.querySelector('[role="combobox"]')).not.toBeNull();
    expect(container.querySelector('[role="listbox"]')?.textContent).toContain("Favorites");
    await act(async () => container.querySelector<HTMLInputElement>('[role="combobox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).not.toHaveBeenCalled();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Agent profile"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="option"][aria-selected="false"]')!.click());
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value).toBe("claude");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe("sonnet");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Permission"]')?.value).toBe("plan");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Agent profile"]')!.click());
    await act(async () => button("Manage agents…").click());
    expect(manage).toHaveBeenCalledOnce();
  });

  it("explains an unavailable selection and never launches it as a free prompt", async () => {
    const preview = vi.fn(); const launch = vi.fn();
    rememberQuickActionDraft("Inspect the release changes");
    await act(async () => root.render(createElement(QuickActionComposer, {
      projects: [{ id: "p", name: "Demo", folder_path: "/tmp/demo" }], selectedProject: undefined, capabilities, profiles: [],
      initialTemplateRef: profile.id, pasteImage: vi.fn(), restoreImage: vi.fn(), discardImage: vi.fn(), preview, launch, close: vi.fn(),
    })));
    expect(container.querySelector('[aria-label="Agent profile"]')?.textContent).toContain("Unavailable agent");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Choose another agent");
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(preview).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  });

  it("rejects editing over a newer version even when the library revision is current", async () => {
    const update = vi.fn();
    const library: AgentLibraryController = { value: { revision: 3, profiles: [profile] }, loading: false, error: undefined, reload: vi.fn(), create: vi.fn(), update, remove: vi.fn(), favorite: vi.fn() };
    const props = { profile, duplicate: false, library, capabilities, canRun: true, open: vi.fn(), copy: vi.fn(), run: vi.fn(), close: vi.fn() };
    await act(async () => root.render(createElement(AgentProfilePanel, props)));
    await act(async () => root.render(createElement(AgentProfilePanel, { ...props, profile: { ...profile, version: 2, instructions: "New instructions" }, library: { ...library, value: { revision: 4, profiles: [] } } })));
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(update).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    await act(async () => button("Load current version").click());
    expect(container.querySelector('textarea')?.value).toBe("New instructions");
  });

  it("rejects a late mutation from the previous connection", async () => {
    let finishCreate!: (value: { revision: number; profiles: AgentLibraryEntry[] }) => void;
    const oldApi = { agentLibraryGet: vi.fn().mockResolvedValue({ revision: 0, profiles: [] }), agentProfileCreate: vi.fn().mockReturnValue(new Promise((resolve) => { finishCreate = resolve; })) } as unknown as SourceDesktopApi;
    const newApi = { agentLibraryGet: vi.fn().mockResolvedValue({ revision: 2, profiles: [{ ...profile, name: "Remote agent" }] }) } as unknown as SourceDesktopApi;
    let controller!: AgentLibraryController;
    function Library({ api }: { api: SourceDesktopApi }) { controller = useAgentLibrary(api, true); return null; }
    await act(async () => root.render(createElement(Library, { api: oldApi })));
    const pending = controller.create(agentDraft(profile), 0).catch((error: Error) => error.message);
    await act(async () => root.render(createElement(Library, { api: newApi })));
    await act(async () => finishCreate({ revision: 1, profiles: [profile] }));
    expect(await pending).toContain("connection changed");
    expect(controller.value?.profiles[0]?.name).toBe("Remote agent");
  });
});
