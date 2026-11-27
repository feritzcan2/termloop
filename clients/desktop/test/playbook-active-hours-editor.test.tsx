// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybookActiveHoursDto } from "@termloop/contract/current";
import { PlaybookActiveHoursEditor } from "../src/renderer/ui/PlaybookActiveHoursEditor.js";

let host: HTMLDivElement;
let root: Root;
const save = vi.fn(async (_hours: PlaybookActiveHoursDto | null) => {});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  save.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function render(scope: "playbook" | "step", hours: PlaybookActiveHoursDto | null, inherited?: PlaybookActiveHoursDto | null) {
  await act(async () => root.render(<PlaybookActiveHoursEditor scope={scope} hours={hours} inherited={inherited}
    busy={false} save={save} />));
}
const field = <T extends HTMLElement>(label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!;
async function type(label: string, value: string) {
  await act(async () => {
    const input = field<HTMLInputElement>(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = () => host.querySelector<HTMLButtonElement>("button")!;
const hint = () => host.querySelector(".ap-hint")!.textContent;

it("turns a Playbook window on with editable hours and saves it", async () => {
  await render("playbook", null);
  expect(hint()).toContain("around the clock");
  expect(button().disabled).toBe(true);
  await act(async () => field<HTMLInputElement>("Limit Playbook active hours").click());
  await type("Playbook active hours start", "22:00");
  await type("Playbook active hours end", "06:30");
  expect(hint()).toContain("spans midnight");
  await act(async () => button().click());
  expect(save).toHaveBeenCalledOnce();
  const saved = save.mock.calls[0]![0]!;
  expect(saved.startMinute).toBe(1320);
  expect(saved.endMinute).toBe(390);
  expect(saved.timeZone.length).toBeGreaterThan(0);
});

it("lets a step follow the Playbook's hours again by clearing its own window", async () => {
  const own = { startMinute: 540, endMinute: 1020, timeZone: "Europe/Berlin" };
  await render("step", own, { startMinute: 480, endMinute: 1200, timeZone: "UTC" });
  expect(field<HTMLSelectElement>("step active hours time zone").value).toBe("Europe/Berlin");
  expect(button().disabled).toBe(true);
  await act(async () => field<HTMLInputElement>("Limit step active hours").click());
  expect(hint()).toContain("08:00–20:00 UTC");
  await act(async () => button().click());
  expect(save).toHaveBeenCalledExactlyOnceWith(null);
});

it("refuses a window that opens and closes at the same time", async () => {
  await render("playbook", { startMinute: 540, endMinute: 1020, timeZone: "UTC" });
  await type("Playbook active hours end", "09:00");
  expect(button().disabled).toBe(true);
  expect(hint()).toContain("different times");
});
