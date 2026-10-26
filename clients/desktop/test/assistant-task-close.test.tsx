// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "../src/renderer/model.js";
import { AssistantTaskTail, type CloseCompletedTask } from "../src/renderer/ui/AssistantTaskRows.js";

let host: HTMLDivElement;
let root: Root;
const plain = { id: "plain", title: "Plain fix", status: "open", developer_notes: [] } as unknown as Task;
const isolated = { id: "isolated", title: "Isolated fix", status: "open", developer_notes: [], worktree: { path: "/tmp/isolated" } } as unknown as Task;
const waiting = { id: "waiting", title: "Waiting fix", status: "open", developer_notes: [] } as unknown as Task;
const closed = { id: "closed", title: "Closed fix", status: "closed", developer_notes: [] } as unknown as Task;
const inspect = vi.fn<CloseCompletedTask["inspect"]>();
const closeTaskAndWorktree = vi.fn<CloseCompletedTask["closeTaskAndWorktree"]>();
const overlayVisibilityChanged = vi.fn<CloseCompletedTask["overlayVisibilityChanged"]>();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  inspect.mockReset().mockReturnValue(new Promise(() => undefined));
  closeTaskAndWorktree.mockReset().mockResolvedValue({ status: "completed" });
  overlayVisibilityChanged.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(busyTaskIds: ReadonlySet<string> = new Set()) {
  await act(async () => root.render(<AssistantTaskTail
    placement={{ byRoutineId: new Map(), completed: [plain, isolated], unplaced: [waiting], closed: [closed] }}
    processingTaskIds={[]}
    openTask={() => undefined}
    closeTask={{ inspect, closeTaskAndWorktree, busyTaskIds, overlayContainer: undefined, overlayVisibilityChanged }}
  />));
}
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

it("offers a close action only on Completed Tasks", async () => {
  await render();
  expect(host.querySelectorAll(".assistant-task-close")).toHaveLength(2);
  expect(button("Close Plain fix")).not.toBeNull();
  expect(button("Close Isolated fix and remove its worktree")).not.toBeNull();
  expect(button("Close Waiting fix")).toBeNull();
  expect(button("Close Closed fix")).toBeNull();
});

it("closes a Task without a worktree directly", async () => {
  await render();
  await act(async () => button("Close Plain fix")!.click());
  expect(closeTaskAndWorktree).toHaveBeenCalledExactlyOnceWith("plain");
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
});

it("inspects the worktree before closing a Task that has one", async () => {
  await render();
  await act(async () => button("Close Isolated fix and remove its worktree")!.click());
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("Remove worktree for “Isolated fix”?");
  expect(inspect).toHaveBeenCalledWith("isolated");
  expect(closeTaskAndWorktree).not.toHaveBeenCalled();
});

it("disables the action while that Task is already closing", async () => {
  await render(new Set(["plain"]));
  expect(button("Close Plain fix")!.disabled).toBe(true);
  expect(button("Close Isolated fix and remove its worktree")!.disabled).toBe(false);
});

it("holds an overlay lease while the dialog is open so the native terminal yields its clicks", async () => {
  await render();
  expect(overlayVisibilityChanged).not.toHaveBeenCalled();
  await act(async () => button("Close Isolated fix and remove its worktree")!.click());
  expect(overlayVisibilityChanged.mock.calls).toEqual([[true]]);
  const cancel = [...host.querySelectorAll("button")].find((value) => value.textContent === "Cancel")!;
  await act(async () => cancel.click());
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(overlayVisibilityChanged.mock.calls).toEqual([[true], [false]]);
});

it("releases the lease when the row unmounts with the dialog open", async () => {
  await render();
  await act(async () => button("Close Isolated fix and remove its worktree")!.click());
  await act(async () => root.render(<></>));
  expect(overlayVisibilityChanged.mock.calls).toEqual([[true], [false]]);
});

it("marks the Task highlighted from the Task rail", async () => {
  await act(async () => root.render(<AssistantTaskTail
    placement={{ byRoutineId: new Map(), completed: [plain, isolated], unplaced: [], closed: [] }}
    processingTaskIds={[]}
    openTask={() => undefined}
    highlightedTaskId="isolated"
  />));
  const highlighted = [...host.querySelectorAll(".assistant-task-row.highlighted")];
  expect(highlighted.map((row) => row.getAttribute("aria-label"))).toEqual(["Isolated fix"]);
});
