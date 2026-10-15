// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { StewardPanel, type StewardPanelProps } from "../src/renderer/ui/StewardPanel.js";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

/// Every read stays pending, so the panel renders only its header.
function props(selection: StewardPanelProps["selection"]): StewardPanelProps {
  const pending = () => new Promise<never>(() => {});
  return new Proxy({
    projectId: "project-1", projectName: "Project", selection, refreshToken: 0, agentCapabilities: [],
    close() {}, openTerminal() {}, openTermLoopInstructions() {}, renderTerminal: () => null,
    setupPromptImprovement() {},
  } as unknown as StewardPanelProps, { get: (target, key) => key in target ? target[key as keyof StewardPanelProps] : pending });
}

const howItWorks = () => [...host.querySelectorAll("button")].find((button) => button.textContent === "How it works?");

it("explains the Playbook and Steward from the Steward header and closes again", async () => {
  await act(async () => root.render(<StewardPanel {...props({ kind: "steward" })} />));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => howItWorks()!.click());
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("How the Playbook and Steward work");
  for (const text of ["It never evaluates steps.", "fresh evaluator", "proposes once to close it", "never disputes an evaluator’s verdict"]) {
    expect(dialog.textContent).toContain(text);
  }
  await act(async () => {
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => howItWorks()!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(".shiw-dialog header button")!.click());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it("shows no explanation button on a Routine panel", async () => {
  await act(async () => root.render(<StewardPanel {...props({ kind: "routine", routineId: "routine-1" } as StewardPanelProps["selection"])} />));
  expect(howItWorks()).toBeUndefined();
});
