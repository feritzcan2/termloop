// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickActionImageHandle } from "../src/quick-action-image.js";
import { rememberQuickActionAttachment } from "../src/renderer/quick-action-memory.js";
import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

const composerProps = (restoreImage = vi.fn()) => ({
  projects: [{ id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" }],
  selectedProject: { id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" },
  capabilities: [fullAgentCapability("codex")],
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
});
