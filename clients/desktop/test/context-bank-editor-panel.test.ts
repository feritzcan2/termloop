// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextBankFileDto } from "@termloop/contract/current";
import { ContextBankEditorPanel } from "../src/renderer/ui/ContextBankEditorPanel.js";

const file: ContextBankFileDto = {
  fileId: "a".repeat(64),
  relativePath: "apps/server/AGENTS.md",
  path: "/project/apps/server/AGENTS.md",
  kind: "agents",
  content: "# Server rules\n",
  contentSha256: "1".repeat(64),
  lineCount: 2,
  lineLimit: 100,
  isSymlink: false,
  symlinkTargetPath: null,
  editable: true,
};

describe("Context Bank editor", () => {
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

  const render = (overrides?: Partial<Parameters<typeof ContextBankEditorPanel>[0]>) => act(async () => root.render(createElement(ContextBankEditorPanel, {
    fileId: file.fileId,
    load: async () => file,
    save: vi.fn(),
    close: vi.fn(),
    ...overrides,
  })));

  const editDraft = async (value: string) => {
    const textarea = container.querySelector<HTMLTextAreaElement>(".stage-editor-source");
    await act(async () => {
      if (!textarea) throw new Error("editor missing");
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setValue?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("saves the complete file through its stale content hash", async () => {
    const onSaved = vi.fn();
    const save = vi.fn().mockResolvedValue({
      ...file,
      content: "updated\n",
      contentSha256: "2".repeat(64),
    });
    await render({ save, onSaved });
    await act(async () => undefined);
    await editDraft("updated\n");
    await act(async () => container.querySelector<HTMLButtonElement>(".primary-button")?.click());

    expect(save).toHaveBeenCalledWith(file.fileId, file.contentSha256, "updated\n");
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ contentSha256: "2".repeat(64) }));
    expect(container.querySelector<HTMLTextAreaElement>(".stage-editor-source")?.value).toBe("updated\n");
  });

  it("surfaces a stale save and reloads the current disk version", async () => {
    const current = { ...file, content: "current\n", contentSha256: "3".repeat(64) };
    const load = vi.fn().mockResolvedValueOnce(file).mockResolvedValueOnce(current);
    const save = vi.fn().mockRejectedValue(new Error("changed on disk since it was read"));
    await render({ load, save });
    await act(async () => undefined);
    await editDraft("mine\n");
    await act(async () => container.querySelector<HTMLButtonElement>(".primary-button")?.click());
    expect(container.querySelector(".settings-rail-error")?.textContent).toContain("changed on disk");
    await act(async () => container.querySelector<HTMLButtonElement>(".settings-rail-error button")?.click());
    await act(async () => undefined);
    expect(container.querySelector<HTMLTextAreaElement>(".stage-editor-source")?.value).toBe("current\n");
  });

  it("explains symlink editing and preserves read-only state", async () => {
    await render({ load: async () => ({
      ...file,
      isSymlink: true,
      symlinkTargetPath: "apps/server/CLAUDE.md",
      editable: false,
    }) });
    await act(async () => undefined);
    expect(container.querySelector(".context-editor-notice")?.textContent).toContain("preserves the link");
    expect(container.querySelector<HTMLTextAreaElement>(".stage-editor-source")?.readOnly).toBe(true);
    expect(container.querySelector(".stage-editor-readonly")?.textContent).toBe("Read only");
  });
});
