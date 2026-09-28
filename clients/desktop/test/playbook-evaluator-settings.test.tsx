// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybookEvaluatorSettingsDto } from "@termloop/contract/current";
import { PlaybookEvaluatorSettings } from "../src/renderer/ui/PlaybookEvaluatorSettings.js";

let host: HTMLDivElement;
let root: Root;
const save = vi.fn(async (_settings: PlaybookEvaluatorSettingsDto) => {});
const defaults: PlaybookEvaluatorSettingsDto = { codexModel: null, claudeModel: null, permission: "plan" };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  save.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function render(settings = defaults, busy = false) {
  await act(async () => root.render(<PlaybookEvaluatorSettings settings={settings} busy={busy} save={save} />));
}
async function change(label: string, value: string) {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
    select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("saves a Luna fork with independent permissions and preserves the Claude choice", async () => {
  await render({ ...defaults, claudeModel: "haiku" });
  expect(host.querySelector("button")!.disabled).toBe(true);
  await change("Playbook fork Codex model", "gpt-6-luna");
  await change("Playbook fork permission", "bypassPermissions");
  // Unrelated daemon refreshes return new objects with the same saved values.
  await render({ ...defaults, claudeModel: "haiku" });
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(save).toHaveBeenCalledExactlyOnceWith({ codexModel: "gpt-6-luna", claudeModel: "haiku", permission: "bypassPermissions" });
});
it("distinguishes source inheritance from conversation default and refreshes saved values", async () => {
  await render({ ...defaults, codexModel: "gpt-6-luna" });
  await change("Playbook fork Codex model", "default");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(save).toHaveBeenLastCalledWith({ ...defaults, codexModel: "default" });
  await change("Playbook fork Codex model", "inherit");
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(save).toHaveBeenLastCalledWith(defaults);
  await render({ ...defaults, codexModel: "gpt-6-sol" }, true);
  expect(host.querySelector<HTMLSelectElement>("select")!.value).toBe("gpt-6-sol");
  expect(host.querySelector("button")!.disabled).toBe(true);
  expect([...host.querySelectorAll("select")].every((select) => select.disabled)).toBe(true);
});
