// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import {
  readTaskDeveloperNotes,
  writeTaskDeveloperNotes,
} from "../src/renderer/task-developer-notes-memory.js";
import { TaskDeveloperNotes } from "../src/renderer/ui/TaskDeveloperNotes.js";

beforeEach(() => window.localStorage.clear());

describe("Task developer note memory", () => {
  it("keeps notes isolated by Project and Task and ignores malformed storage", () => {
    writeTaskDeveloperNotes("project-1", "task-1", [{ id: "note-1", text: "  Review empty state  ", completed: false }]);
    writeTaskDeveloperNotes("project-1", "task-2", [{ id: "note-2", text: "Check narrow rail", completed: true }]);

    expect(readTaskDeveloperNotes("project-1", "task-1")).toEqual([
      { id: "note-1", text: "Review empty state", completed: false },
    ]);
    expect(readTaskDeveloperNotes("project-1", "task-2")).toHaveLength(1);
    expect(readTaskDeveloperNotes("project-2", "task-1")).toEqual([]);

    const invalid = { getItem: () => "not json" };
    expect(readTaskDeveloperNotes("project-1", "task-1", invalid)).toEqual([]);
  });
});

describe("Task developer notes in the sidebar", () => {
  it("adds, completes, deletes, and restores vertically listed notes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const view = createElement(TaskDeveloperNotes, {
      projectId: "project-1",
      taskId: "task-1",
      taskTitle: "Ship developer notes",
    });
    await act(async () => root.render(view));

    expect(container.querySelector('[aria-label="Developer notes for Ship developer notes"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add developer note to Ship developer notes"]')!.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="New developer note for Ship developer notes"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Check the compact layout");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());

    const items = container.querySelectorAll(".task-developer-note-list > li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("Check the compact layout");
    expect(container.querySelector(".task-developer-notes-head small")?.textContent).toBe("0/1");

    await act(async () => container.querySelector<HTMLInputElement>('[aria-label^="Complete:"]')!.click());
    expect(container.querySelector(".task-developer-note-list > li")?.className).toBe("completed");
    expect(container.querySelector(".task-developer-notes-head small")?.textContent).toBe("1/1");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(view));
    expect(container.querySelector(".task-developer-note-list > li")?.className).toBe("completed");

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Delete developer note:"]')!.click());
    expect(container.querySelector(".task-developer-note-list")).toBeNull();
    expect(readTaskDeveloperNotes("project-1", "task-1")).toEqual([]);

    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
