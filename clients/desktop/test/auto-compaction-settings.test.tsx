// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AutoCompactionSettingsDto } from "@termloop/contract/current";
import {
  AutoCompactionSettings, autoCompactionDraftValue, withAutoCompactionValue,
} from "../src/renderer/ui/AutoCompactionSettings.js";

let host: HTMLDivElement;
let root: Root;
const save = vi.fn(async (_settings: AutoCompactionSettingsDto) => {});
const defaults: AutoCompactionSettingsDto = { claudeWindowTokens: 250_000, codexThresholdPercent: 90 };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  save.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("accepts only whole values inside the selected provider's unit range", () => {
  expect(autoCompactionDraftValue("claude", "250000")).toBe(250_000);
  expect(autoCompactionDraftValue("claude", "99999")).toBeNull();
  expect(autoCompactionDraftValue("claude", "1000001")).toBeNull();
  expect(autoCompactionDraftValue("codex", "90")).toBe(90);
  expect(autoCompactionDraftValue("codex", "0")).toBeNull();
  expect(autoCompactionDraftValue("codex", "101")).toBeNull();
  expect(autoCompactionDraftValue("codex", "9.5")).toBeNull();
  expect(autoCompactionDraftValue("codex", "")).toBeNull();
});

it("replaces only the selected provider's value", () => {
  expect(withAutoCompactionValue(defaults, "claude", 400_000))
    .toEqual({ claudeWindowTokens: 400_000, codexThresholdPercent: 90 });
  expect(withAutoCompactionValue(defaults, "codex", 75))
    .toEqual({ claudeWindowTokens: 250_000, codexThresholdPercent: 75 });
});

it("saves an edited Codex threshold and keeps the Claude window", async () => {
  await act(async () => root.render(<AutoCompactionSettings agentId="codex" settings={defaults} busy={false} save={save} />));
  const input = host.querySelector<HTMLInputElement>("input")!;
  const button = host.querySelector<HTMLButtonElement>("button")!;
  expect(input.value).toBe("90");
  expect(button.disabled).toBe(true);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "80"); input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(save).toHaveBeenCalledWith({ claudeWindowTokens: 250_000, codexThresholdPercent: 80 });
});
