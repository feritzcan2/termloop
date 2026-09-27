// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybookEvaluationDto } from "@termloop/contract/current";
import type { Session } from "../src/renderer/model.js";
import { PlaybookEvaluationStatus } from "../src/renderer/ui/PlaybookEvaluationStatus.js";

let host: HTMLDivElement;
let root: Root;
const openAgentTerminal = vi.fn();
const openStewardTerminal = vi.fn();
const session = (id: string, name: string): Session => ({
  id, name, lifecycle_state: "running", process: { agent_id: "codex" },
} as Session);
const sessions = [session("source", "Fix search"), session("fork", "Playbook evaluation"), session("steward", "Steward")];
const evaluation: PlaybookEvaluationDto = {
  routineId: "routine-review", taskId: "task", mode: "taskAgentFork",
  sessionId: "fork", sourceSessionId: "source", reason: null,
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function render(value: PlaybookEvaluationDto, rows = sessions) {
  await act(async () => root.render(<PlaybookEvaluationStatus evaluation={value} sessions={rows}
    openAgentTerminal={openAgentTerminal} openStewardTerminal={openStewardTerminal} />));
}
it("opens the exact evaluation fork and names its source without opening Steward", async () => {
  await render(evaluation);
  expect(host.textContent).toContain("Source: Fix search");
  expect(host.textContent).toContain("Checking · Task agent");
  host.querySelector<HTMLButtonElement>("button")!.click();
  expect(openAgentTerminal).toHaveBeenCalledExactlyOnceWith("fork");
  expect(openStewardTerminal).not.toHaveBeenCalled();
});
it("explains startup failure and opens only the projected fallback Steward", async () => {
  await render({ ...evaluation, mode: "stewardFallback", sessionId: "steward", sourceSessionId: null, reason: "forkUnavailable" });
  expect(host.textContent).toContain("The task agent fork could not start. Steward took over.");
  host.querySelector<HTMLButtonElement>("button")!.click();
  expect(openStewardTerminal).toHaveBeenCalledExactlyOnceWith("steward");
  expect(openAgentTerminal).not.toHaveBeenCalled();
});
it("does not route a starting check to Steward or to an unconfirmed fork", async () => {
  await render({ ...evaluation, mode: "starting", sessionId: null });
  expect(host.textContent).toContain("Starting task review");
  expect(host.querySelector("button")).toBeNull();
});
it("removes the terminal link when the ephemeral fork is absent or exited", async () => {
  for (const rows of [[], [{ ...sessions[1]!, lifecycle_state: "exited" as const }]]) {
    await render(evaluation, rows);
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("Connecting to the evaluation terminal");
  }
});
