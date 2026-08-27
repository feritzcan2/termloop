// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillDefinitionDto } from "@termloop/contract/current";
import { SkillEditorPanel } from "../src/renderer/ui/SkillEditorPanel.js";

const definition: SkillDefinitionDto = {
  skillId: "b".repeat(64),
  name: "release",
  path: "/project/.codex/skills/release/SKILL.md",
  content: "---\nname: release\n---\nShip it.\n",
  contentSha256: "1".repeat(64),
  editable: true,
};

describe("Skill editor panel", () => {
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

  const render = (overrides?: Partial<Parameters<typeof SkillEditorPanel>[0]>) =>
    act(async () => root.render(createElement(SkillEditorPanel, {
      skillId: definition.skillId,
      load: async () => definition,
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

  it("loads the definition into an editable markdown surface", async () => {
    await render();
    await act(async () => undefined);

    expect(container.querySelector(".stage-editor-title h2")?.textContent).toBe("release");
    expect(container.querySelector(".stage-editor-title code")?.textContent).toBe(definition.path);
    const textarea = container.querySelector<HTMLTextAreaElement>(".stage-editor-source");
    expect(textarea?.value).toBe(definition.content);
    expect(textarea?.readOnly).toBe(false);
    expect((container.querySelector(".primary-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves edits with the stale-guard hash and adopts the result", async () => {
    const save = vi.fn().mockResolvedValue({
      ...definition,
      content: "updated\n",
      contentSha256: "2".repeat(64),
    });
    await render({ save });
    await act(async () => undefined);

    await editDraft("updated\n");
    const saveButton = container.querySelector<HTMLButtonElement>(".primary-button");
    expect(saveButton?.disabled).toBe(false);
    await act(async () => saveButton?.click());

    expect(save).toHaveBeenCalledWith(definition.skillId, "1".repeat(64), "updated\n");
    expect(container.querySelector<HTMLButtonElement>(".primary-button")?.disabled).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>(".stage-editor-source")?.value).toBe("updated\n");
  });

  it("surfaces a save conflict and reloads the current content", async () => {
    const reloaded = { ...definition, content: "fresh\n", contentSha256: "3".repeat(64) };
    const load = vi.fn().mockResolvedValueOnce(definition).mockResolvedValueOnce(reloaded);
    const save = vi.fn().mockRejectedValue(new Error("SKILL.md changed on disk since it was read; reload before saving"));
    await render({ load, save });
    await act(async () => undefined);

    await editDraft("mine\n");
    await act(async () => container.querySelector<HTMLButtonElement>(".primary-button")?.click());

    expect(container.querySelector(".settings-rail-error")?.textContent).toContain("changed on disk");
    const reload = [...container.querySelectorAll<HTMLButtonElement>(".settings-rail-error button")][0];
    await act(async () => reload?.click());
    await act(async () => undefined);

    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLTextAreaElement>(".stage-editor-source")?.value).toBe("fresh\n");
  });

  it("renders provider-owned definitions read only", async () => {
    await render({ load: async () => ({ ...definition, editable: false }) });
    await act(async () => undefined);

    expect(container.querySelector(".stage-editor-readonly")?.textContent).toBe("Read only");
    expect(container.querySelector<HTMLTextAreaElement>(".stage-editor-source")?.readOnly).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".primary-button")?.disabled).toBe(true);
  });

  it("closes back to the terminal stage", async () => {
    const close = vi.fn();
    await render({ close });
    await act(async () => undefined);

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close skill editor"]')?.click());
    expect(close).toHaveBeenCalled();
  });
});
