// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybookEvaluationHistoryResult, PlaybookEvaluationRecordDto } from "@termloop/contract/current";
import type { Task } from "../src/renderer/model.js";
import { AssistantTaskRow } from "../src/renderer/ui/AssistantTaskRows.js";

let host: HTMLDivElement;
let root: Root;
const task = { id: "task-1", title: "Fix search", status: "open" } as Task;
const record = (id: string, taskId: string, evidence: string): PlaybookEvaluationRecordDto => ({
  id, projectId: "project-1", taskId, taskTitle: taskId === "task-1" ? "Fix search" : "Other", milestoneId: "m-1",
  milestoneTitle: "Promotion PR open", sourceSessionId: null, sourceName: null, sessionId: `s-${id}`,
  agentId: "claude", model: "default", permission: "plan", startedAtEpochMs: 1, finishedAtEpochMs: 2,
  outcome: "blocked", evidence,
});
const load = vi.fn<() => Promise<PlaybookEvaluationHistoryResult>>();
const openTask = vi.fn();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  openTask.mockReset();
  load.mockReset().mockResolvedValue({
    entries: [record("a", "task-1", "PR is not open yet."), record("b", "task-2", "Unrelated verdict.")],
    retentionLimit: 200, stateRevision: 1,
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("loads only on demand and shows just this Task's checks without opening the Task", async () => {
  await act(async () => root.render(<AssistantTaskRow task={task} processingTaskIds={[]} openTask={openTask} loadEvaluationHistory={load} />));
  expect(load).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Check history for Fix search"]')!.click());
  expect(openTask).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("PR is not open yet.");
  expect(host.textContent).not.toContain("Unrelated verdict.");
});

it("says so when the Task has no checks and reports load failures", async () => {
  load.mockResolvedValueOnce({ entries: [], retentionLimit: 200, stateRevision: 1 });
  await act(async () => root.render(<AssistantTaskRow task={task} processingTaskIds={[]} openTask={openTask} loadEvaluationHistory={load} />));
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Check history for Fix search"]')!;
  await act(async () => toggle.click());
  expect(host.textContent).toContain("No checks recorded yet");
  await act(async () => toggle.click());
  load.mockRejectedValueOnce(new Error("offline"));
  await act(async () => toggle.click());
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("could not be loaded");
});
