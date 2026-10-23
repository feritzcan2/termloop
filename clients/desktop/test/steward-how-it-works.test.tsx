// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AssistantRail } from "../src/renderer/ui/AssistantRail.js";
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
/// The dialog is portaled to the document root, outside the panel.
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

it("explains the Playbook and Steward from the Steward header and closes again", async () => {
  await act(async () => root.render(<StewardPanel {...props({ kind: "steward" })} />));
  expect(dialog()).toBeNull();
  await act(async () => howItWorks()!.click());
  expect(dialog()!.textContent).toContain("How the Playbook and Steward work");
  for (const text of ["It never evaluates steps.", "fresh evaluator", "If the Task has no running agent, no evaluator is started", "A human gate can never trust a report", "click ✓ next to the Task", "proposes once to close it", "never disputes an evaluator’s verdict"]) {
    expect(dialog()!.textContent).toContain(text);
  }
  await act(async () => {
    dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(dialog()).toBeNull();
  await act(async () => howItWorks()!.click());
  await act(async () => document.querySelector<HTMLButtonElement>(".shiw-dialog header button")!.click());
  expect(dialog()).toBeNull();
});

it("shows no explanation button on a Routine panel", async () => {
  await act(async () => root.render(<StewardPanel {...props({ kind: "routine", routineId: "routine-1" } as StewardPanelProps["selection"])} />));
  expect(howItWorks()).toBeUndefined();
});

it("offers the explanation in the sidebar Steward tab", async () => {
  const pending = () => new Promise<never>(() => {});
  const reads = Object.fromEntries(["createRoutine", "deleteRoutine", "deleteSteward", "getPlaybook", "getSteward",
    "listRoutines", "listRuntime", "restartSteward", "runRoutineNow", "setPlaybookTaskPosition", "setSteward",
    "updatePlaybook", "updateRoutine"].map((name) => [name, pending]));
  const railProps = {
    ...reads, projectId: "project-1", refreshToken: 0, sessions: [], statusesById: new Map(), tasks: [],
    playbookRuntime: null, disabled: false, selectedSessionId: undefined, selection: { kind: "steward" },
    agentCapabilities: [], openDetails() {}, dismissImproverSession() {}, openImproverTerminal() {}, openTask() {},
    selectSession() {}, setupPromptImprovement() {},
  } as unknown as Parameters<typeof AssistantRail>[0];
  await act(async () => root.render(<AssistantRail {...railProps} />));
  const heading = host.querySelector(".ar-head")!;
  const button = [...heading.querySelectorAll("button")].find((candidate) => candidate.textContent === "How it works?");
  await act(async () => button!.click());
  expect(dialog()!.textContent).toContain("How the Playbook and Steward work");
  await act(async () => document.querySelector<HTMLButtonElement>(".shiw-backdrop")!.click());
  expect(dialog()).toBeNull();
});

it("opens above native terminals in the overlay container and releases its lease on close", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const reports: boolean[] = [];
  const overlay = { container, visibilityChanged: (visible: boolean) => { reports.push(visible); } };
  await act(async () => root.render(<StewardPanel {...props({ kind: "steward" })} howItWorksOverlay={overlay} />));
  await act(async () => howItWorks()!.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(reports).toEqual([true]);
  await act(async () => container.querySelector<HTMLButtonElement>(".shiw-backdrop")!.click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(reports).toEqual([true, false]);
  container.remove();
});
