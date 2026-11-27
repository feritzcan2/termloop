// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlaybookEvaluationRecordDto, PlaybookTaskTimelineResult } from "@termloop/contract/current";
import type { Task } from "../src/renderer/model.js";
import { AssistantTaskRow } from "../src/renderer/ui/AssistantTaskRows.js";

let host: HTMLDivElement;
let root: Root;
const task = { id: "task-1", title: "Fix search", status: "open" } as Task;
const record = (id: string, evidence: string): PlaybookEvaluationRecordDto => ({
  id, projectId: "project-1", taskId: "task-1", taskTitle: "Fix search", milestoneId: "m-1",
  milestoneTitle: "Promotion PR open", sourceSessionId: null, sourceName: null, sessionId: `s-${id}`,
  agentId: "claude", model: "default", permission: "plan", startedAtEpochMs: 1, finishedAtEpochMs: 2,
  outcome: "blocked", evidence,
});
const timeline = (entries: PlaybookTaskTimelineResult["entries"], truncated = false): PlaybookTaskTimelineResult =>
  ({ taskId: "task-1", entries, truncated, stateRevision: 1 });
const load = vi.fn<(taskId: string) => Promise<PlaybookTaskTimelineResult>>();
const openTask = vi.fn();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  openTask.mockReset();
  load.mockReset().mockResolvedValue(timeline([
    { kind: "steward", atEpochMs: 5, milestoneId: null, milestoneTitle: null,
      steward: { messageId: "m-9", messageKind: "action", content: "Sent the Agent a message: “Open the PR.”" } },
    { kind: "decision", atEpochMs: 4, milestoneId: "m-0", milestoneTitle: "Implemented",
      decision: { verdict: "passed", evaluator: "user", evidence: "Position set manually from Task details.", pullRequestNumber: null } },
    { kind: "evaluation", atEpochMs: 2, milestoneId: "m-1", milestoneTitle: "Promotion PR open", evaluation: {
      ...record("a", "PR is not open yet."),
      agentReport: { status: "reached", evidence: "Opened PR #7.", reportedAtEpochMs: 1 },
      criteria: [
        { criterion: "A promotion PR is open", status: "unmet", evidence: "No PR from the Task branch." },
        { criterion: "CI is green", status: "unknown", evidence: "No run to read." },
      ],
    } },
  ]));
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("loads this Task's timeline only on demand without opening the Task", async () => {
  await act(async () => root.render(<AssistantTaskRow task={task} processingTaskIds={[]} openTask={openTask} loadTaskTimeline={load} />));
  expect(load).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Check history for Fix search"]')!.click());
  expect(openTask).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledExactlyOnceWith("task-1");
  const text = host.textContent ?? "";
  expect(text).toContain("PR is not open yet.");
  expect(text).toContain("Task Agent reported the step reached:");
  expect(text).toContain("Opened PR #7.");
  expect(text).toContain("0 of 2 criteria met");
  expect(text).toContain("Set by you");
  expect(text).toContain("Open the PR.");
  // Criteria stay collapsed until the user asks for them.
  expect(host.querySelector<HTMLDetailsElement>(".peh-criteria")!.open).toBe(false);
});

it("says so when the Task has no history, when it is truncated, and on load failures", async () => {
  load.mockResolvedValueOnce(timeline([]));
  await act(async () => root.render(<AssistantTaskRow task={task} processingTaskIds={[]} openTask={openTask} loadTaskTimeline={load} />));
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Check history for Fix search"]')!;
  await act(async () => toggle.click());
  expect(host.textContent).toContain("No checks recorded yet");
  await act(async () => toggle.click());
  load.mockResolvedValueOnce(timeline([{ kind: "steward", atEpochMs: 5, milestoneId: null, milestoneTitle: null,
    steward: { messageId: "m-1", messageKind: "action", content: "Handled finding." } }], true));
  await act(async () => toggle.click());
  expect(host.textContent).toContain("Showing the newest 1 entries.");
  await act(async () => toggle.click());
  load.mockRejectedValueOnce(new Error("offline"));
  await act(async () => toggle.click());
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("could not be loaded");
});
