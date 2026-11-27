// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybookStepEvaluatorModelsDto } from "@termloop/contract/current";
import { PlaybookStepModelSelector } from "../src/renderer/ui/PlaybookStepModelSelector.js";

let host: HTMLDivElement;
let root: Root;
const save = vi.fn(async (_models: PlaybookStepEvaluatorModelsDto | null) => {});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  save.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function render(models: PlaybookStepEvaluatorModelsDto | null) {
  await act(async () => root.render(<PlaybookStepModelSelector models={models} busy={false} save={save}
    projectSettings={{ codexModel: "gpt-6-luna", claudeModel: null, permission: "plan" }} />));
}
const select = (label: string) => host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
async function change(label: string, value: string) {
  await act(async () => { const s = select(label); s.value = value; s.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function type(label: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = () => host.querySelector<HTMLButtonElement>("button")!;

it("names the Project setting and saves a catalog model for one provider", async () => {
  await render(null);
  expect(select("Step evaluator Codex model").selectedOptions[0]!.textContent).toBe("Project setting (gpt-6-luna)");
  expect(button().disabled).toBe(true);
  await change("Step evaluator Claude model", "haiku");
  await act(async () => button().click());
  expect(save).toHaveBeenCalledExactlyOnceWith({ codexModel: null, claudeModel: "haiku" });
});

it("saves a typed custom model and shows a saved custom model as typed text", async () => {
  await render(null);
  await change("Step evaluator Codex model", "custom");
  expect(button().disabled).toBe(true);
  await type("Step evaluator custom Codex model", "my-codex-model");
  await act(async () => button().click());
  expect(save).toHaveBeenLastCalledWith({ codexModel: "my-codex-model", claudeModel: null });
  await render({ codexModel: "my-codex-model", claudeModel: null });
  expect(select("Step evaluator Codex model").value).toBe("custom");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Step evaluator custom Codex model"]')!.value).toBe("my-codex-model");
});

it("returning every provider to the Project setting saves null", async () => {
  await render({ codexModel: "gpt-6-sol", claudeModel: null });
  await change("Step evaluator Codex model", "project");
  await act(async () => button().click());
  expect(save).toHaveBeenLastCalledWith(null);
});
