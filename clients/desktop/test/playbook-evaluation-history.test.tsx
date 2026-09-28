// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybookEvaluationHistoryResult, PlaybookEvaluationRecordDto } from "@termloop/contract/current";
import { PlaybookEvaluationHistory } from "../src/renderer/ui/PlaybookEvaluationHistory.js";

const entry: PlaybookEvaluationRecordDto = {
  id: "check-1", projectId: "project-1", taskId: "task-1", taskTitle: "Fix SearchUsers",
  milestoneId: "dev-verified", milestoneTitle: "Dev verified", sourceSessionId: "source-1",
  sourceName: "Implementer", sessionId: "fork-1", agentId: "codex", model: "gpt-6-luna",
  permission: "plan", startedAtEpochMs: 1000, finishedAtEpochMs: 2000,
  outcome: "waiting", evidence: "Deployment passed; Ferit’s scenario approval is pending.",
};
const result = (entries: PlaybookEvaluationRecordDto[]): PlaybookEvaluationHistoryResult => ({ entries, retentionLimit: 200, stateRevision: 5 });
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

it("shows fork provenance, outcome and full evidence without requiring a live Session", async () => {
  const load = vi.fn(async () => result([entry]));
  await act(async () => root.render(<PlaybookEvaluationHistory load={load} refreshToken={0} />));
  expect(load).toHaveBeenCalledOnce();
  for (const text of [entry.taskTitle, entry.milestoneTitle, entry.sourceName, entry.model, entry.evidence, "Pending", "fork-1", "last 200"]) {
    expect(host.textContent).toContain(text);
  }
  expect(host.querySelectorAll("ol > li")).toHaveLength(1);
  expect(host.querySelector("time")!.dateTime).toBe(new Date(1000).toISOString());
});

it("refreshes on invalidation and on request, recovers from errors and explains empty history", async () => {
  const load = vi.fn<() => Promise<PlaybookEvaluationHistoryResult>>()
    .mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValueOnce(result([]))
    .mockResolvedValueOnce(result([{ ...entry, outcome: "passed" }]));
  await act(async () => root.render(<PlaybookEvaluationHistory load={load} refreshToken={0} />));
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("could not be loaded");
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("No fork checks recorded yet");
  await act(async () => root.render(<PlaybookEvaluationHistory load={load} refreshToken={1} />));
  expect(host.textContent).toContain("Passed");
  expect(load).toHaveBeenCalledTimes(3);
});

it("discards an older read that resolves after a newer result", async () => {
  let resolveOld!: (value: PlaybookEvaluationHistoryResult) => void;
  const old = new Promise<PlaybookEvaluationHistoryResult>((resolve) => { resolveOld = resolve; });
  const load = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(result([{ ...entry, outcome: "passed" }]));
  await act(async () => root.render(<PlaybookEvaluationHistory load={load} refreshToken={0} />));
  expect(host.textContent).toContain("Loading checks");
  await act(async () => root.render(<PlaybookEvaluationHistory load={load} refreshToken={1} />));
  await act(async () => resolveOld(result([{ ...entry, outcome: "inProgress", evidence: "", finishedAtEpochMs: null }])));
  expect(host.textContent).toContain("Passed");
  expect(host.textContent).not.toContain("In progress");
});
