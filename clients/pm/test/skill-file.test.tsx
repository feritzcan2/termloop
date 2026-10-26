// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { SkillFile } from "../src/renderer/ui/SkillFile.js";
import { fakeBridge, ok, skill } from "./fixtures.js";
import { render } from "./render.js";

function typeArea(area: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

describe("SkillFile", () => {
  it("saves only the fields the PM changed as the next version", async () => {
    const onSave = vi.fn(async () => true);
    const { container, unmount } = render(<SkillFile skill={skill({ version: 2 })} onSave={onSave} />);
    expect(container.textContent).toContain("SKILL.md");
    expect(button(container, "Save as v3")!.disabled).toBe(true);
    typeArea(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions"]')!, "Look harder.");
    expect(container.textContent).toContain("Unsaved");
    await act(async () => button(container, "Save as v3")!.click());
    expect(onSave).toHaveBeenCalledWith({ instructions: "Look harder." });
    typeArea(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instructions"]')!, " ");
    expect(button(container, "Save as v3")!.disabled).toBe(true);
    unmount();
  });

  it("opens in the stage and saves through pm_skill_update", async () => {
    const bridge = fakeBridge(() => ok(skill({ version: 2 })));
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    controller.openSkill("skill-1");
    expect(controller.state.view).toBe("skill");
    expect(controller.state.openSkillId).toBe("skill-1");
    expect(await controller.updateSkill("skill-1", { name: "Owners" })).toBe(true);
    expect(bridge.calls.at(-1)).toEqual({ method: "pm_skill_update", params: { skillId: "skill-1", name: "Owners" } });
  });
});
