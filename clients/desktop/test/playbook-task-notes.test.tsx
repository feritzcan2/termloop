// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "../src/renderer/model.js";
import { AssistantTaskRow } from "../src/renderer/ui/AssistantTaskRows.js";
import type { SavePlaybookTaskNotes } from "../src/renderer/ui/PlaybookTaskNotes.js";

let host: HTMLDivElement;
let root: Root;
const existing = { id: "original", text: "Existing instruction", completed: false };
const task = { id: "task-1", title: "Fix search", status: "open", developer_notes: [existing] } as Task;
const save = vi.fn<SavePlaybookTaskNotes>();
const openTask = vi.fn();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  save.mockReset().mockResolvedValue(undefined); openTask.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function render(value = task, disabled = false) {
  await act(async () => root.render(<AssistantTaskRow task={value} processingTaskId="task-1" openTask={openTask} saveTaskNotes={save} notesDisabled={disabled} />));
}
async function typeNote(text: string) {
  await act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
}

it("opens a small editor without opening Task details and appends to the latest notes", async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Notes for Fix search"]')!.click());
  expect(openTask).not.toHaveBeenCalled();
  expect(host.textContent).toContain(existing.text);
  await typeNote("  Ferit approved the DEV scenario.  ");
  const concurrent = { id: "another", text: "A concurrent note", completed: false };
  await render({ ...task, developer_notes: [existing, concurrent] });
  expect(host.querySelector("textarea")!.value).toContain("Ferit approved");
  await submit();
  expect(save).toHaveBeenCalledExactlyOnceWith("task-1", [existing, concurrent], [existing, concurrent, {
    id: expect.any(String), text: "Ferit approved the DEV scenario.", completed: false,
  }]);
  expect(host.textContent).toContain("Note saved");
  expect(host.querySelector("textarea")!.value).toBe("");
});

it("preserves the draft on save failure and lets the user retry", async () => {
  save.mockResolvedValueOnce("Task notes changed. Refresh and try again.");
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Notes for Fix search"]')!.click());
  await typeNote("Keep this note"); await submit();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Task notes changed");
  expect(host.querySelector("textarea")!.value).toBe("Keep this note");
  await submit();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(save).toHaveBeenCalledTimes(2);
});

it("disables saves offline and enforces the Task note bounds", async () => {
  await render(task, true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Notes for Fix search"]')!.click());
  expect(host.querySelector("textarea")!.disabled).toBe(true);
  expect(host.querySelector("textarea")!.maxLength).toBe(280);
  await render({ ...task, developer_notes: Array.from({ length: 50 }, (_, i) => ({ ...existing, id: `${i}` })) });
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  expect(host.textContent).toContain("Task note limit reached");
  expect(save).not.toHaveBeenCalled();
});
