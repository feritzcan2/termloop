// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickActionImageHandle } from "../src/quick-action-image.js";
import { rememberQuickActionAttachment } from "../src/renderer/quick-action-memory.js";
import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { fullAgentCapability, observableGeminiCapability } from "./agent-capability-fixture.js";

const composerProps = (restoreImage = vi.fn()) => ({
  projects: [{ id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" }],
  selectedProject: { id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" },
  capabilities: [fullAgentCapability("codex")],
  profiles: [],
  pasteImage: vi.fn(),
  restoreImage,
  discardImage: vi.fn(),
  preview: vi.fn(),
  launch: vi.fn(),
  close: vi.fn(),
});

describe("Quick Action draft", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("restores text after the composer closes without launching", async () => {
    await act(async () => root.render(createElement(QuickActionComposer, composerProps())));
    const prompt = container.querySelector<HTMLTextAreaElement>("#quick-action-prompt");
    expect(prompt).not.toBeNull();

    await act(async () => {
      if (!prompt) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
        ?.call(prompt, "keep this unfinished request");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => root.unmount());

    root = createRoot(container);
    await act(async () => root.render(createElement(QuickActionComposer, composerProps())));
    expect(container.querySelector<HTMLTextAreaElement>("#quick-action-prompt")?.value)
      .toBe("keep this unfinished request");
  });

  it("restores a saved image attachment when the composer reopens", async () => {
    const attachment: QuickActionImageHandle = {
      id: "58df9988-2939-4d63-a546-6ebbd0c15f16",
      mediaType: "image/png",
      byteLength: 128,
      sha256: `sha256:${"a".repeat(64)}`,
      width: 40,
      height: 30,
      previewDataUrl: "data:image/png;base64,cHJldmlldw==",
    };
    rememberQuickActionAttachment(attachment);
    const restoreImage = vi.fn().mockResolvedValue(attachment);

    await act(async () => root.render(createElement(QuickActionComposer, composerProps(restoreImage))));
    await act(async () => undefined);

    expect(restoreImage).toHaveBeenCalledWith(attachment.id);
    expect(container.querySelector<HTMLImageElement>('.quick-action-attachment img')?.src)
      .toBe(attachment.previewDataUrl);
  });

  it("keeps Agent Profile permission user-selectable", async () => {
    const props = {
      ...composerProps(),
      profiles: [{
        id: "builtin.agent-profile.scattered-orchestration-finder" as const,
        name: "Scattered Orchestration Finder",
        description: "Find scattered orchestration.",
        category: "Architecture",
        version: 1,
        permission: "plan" as const,
        read_only: true,
        user_invocable: true,
        agent_ids: ["codex"],
      }],
    };
    await act(async () => root.render(createElement(QuickActionComposer, props)));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Agent profile"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="option"][aria-selected="false"]')!.click());

    const permission = container.querySelector<HTMLSelectElement>('select[aria-label="Permission"]');
    expect(permission?.value).toBe("plan");
    expect(permission?.disabled).toBe(false);
    expect([...permission?.options ?? []].map((option) => option.value))
      .toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    await act(async () => {
      if (!permission) return;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
        ?.call(permission, "bypassPermissions");
      permission.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(permission?.value).toBe("bypassPermissions");
    expect(container.querySelector('label[for="quick-action-prompt"]')?.textContent).toBe("Scope / task");
  });

  it("keeps permission selectable when a profile switches providers", async () => {
    const props = {
      ...composerProps(),
      initialAgent: "gemini",
      capabilities: [observableGeminiCapability(), fullAgentCapability("codex")],
      profiles: [{
        id: "builtin.agent-profile.scattered-orchestration-finder" as const,
        name: "Scattered Orchestration Finder",
        description: "Find scattered orchestration.",
        category: "Architecture",
        version: 1,
        permission: "plan" as const,
        read_only: true,
        user_invocable: true,
        agent_ids: ["codex"],
      }],
    };
    await act(async () => root.render(createElement(QuickActionComposer, props)));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Agent profile"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[role="option"][aria-selected="false"]')!.click());

    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')?.value).toBe("codex");
    const permission = container.querySelector<HTMLSelectElement>('select[aria-label="Permission"]');
    expect(permission?.value).toBe("plan");
    expect(permission?.disabled).toBe(false);
  });
  it("uses the server default and sends an explicit alternative account to preview and launch", async () => {
    const props = composerProps();
    const accounts = [
      { agentId: "codex" as const, accountId: "default", name: "Server user", isDefault: false },
      { agentId: "codex" as const, accountId: "c3dcf1a0-2548-420c-b662-2a2143a567da", name: "Work", isDefault: true },
    ];
    const loadAccounts = vi.fn(async () => accounts);
    props.preview.mockResolvedValue({ launch_ticket: "approved-ticket", manifest: { digest: "sha256:fixture" } });
    props.launch.mockResolvedValue(undefined);
    await act(async () => root.render(createElement(QuickActionComposer, { ...props, loadAccounts })));
    const account = container.querySelector<HTMLSelectElement>("#quick-action-account")!;
    expect(account.value).toBe(accounts[1]!.accountId);
    await act(async () => { account.value = "default"; account.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => {
      const prompt = container.querySelector<HTMLTextAreaElement>("#quick-action-prompt")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Check this account");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(props.preview.mock.calls.at(-1)?.at(-1)).toBe("default");
    expect(props.launch.mock.calls.at(-1)?.slice(-2)).toEqual(["approved-ticket", "default"]);
    expect(props.close).toHaveBeenCalledOnce();
  });

  it("discards account choices from a previous project while another server is selected", async () => {
    const props = composerProps();
    props.projects.push({ id: "project-2", name: "Remote", folder_path: "/remote" });
    let deliver!: (value: { agentId: "codex"; accountId: string; name: string; isDefault: boolean }[]) => void;
    const loadAccounts = vi.fn((projectId: string) => projectId === "project-1" ? new Promise<typeof accounts>((resolve) => { deliver = resolve; }) : Promise.resolve(accounts));
    const accounts = [{ agentId: "codex" as const, accountId: "default", name: "Remote account", isDefault: true }];
    await act(async () => root.render(createElement(QuickActionComposer, { ...props, loadAccounts })));
    expect(container.querySelector<HTMLSelectElement>("#quick-action-account")!.disabled).toBe(true);
    await act(async () => { const project = container.querySelector<HTMLSelectElement>('select[aria-label="Run in Project"]')!; project.value = "project-2"; project.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => deliver([{ agentId: "codex", accountId: "c3dcf1a0-2548-420c-b662-2a2143a567da", name: "Old server", isDefault: true }]));
    expect(container.querySelector<HTMLSelectElement>("#quick-action-account")!.value).toBe("default");
    expect(container.textContent).toContain("Remote account");
    expect(container.textContent).not.toContain("Old server");
  });

});
