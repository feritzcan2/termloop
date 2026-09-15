// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowCloseDialog } from "../src/renderer/ui/WorkflowCloseDialog.js";

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; host?.remove(); });
async function mount(submit = vi.fn().mockResolvedValue(undefined)) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const close = vi.fn();
  await act(async () => root!.render(createElement(WorkflowCloseDialog, {
    target: { projectId: "project-1", executionId: "run-1", name: "Build and verify", agentCount: 3 }, submit, close,
  })));
  return { submit, close };
}
const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === label)!;

it("explains the whole-group scope and recovery, and defaults focus to keeping agents open", async () => {
  const f = await mount();
  expect(host.textContent).toContain("close all 3 agents");
  expect(host.textContent).toContain("Deleted for 30 days");
  expect(document.activeElement).toBe(button("Keep open"));
  expect(f.submit).not.toHaveBeenCalled();
  await act(async () => button("Keep open").click());
  expect(f.close).toHaveBeenCalledTimes(1); expect(f.submit).not.toHaveBeenCalled();
});

it("submits one exact group once, disables repeat actions and waits before dismissing", async () => {
  let resolve!: (value: undefined) => void;
  const submit = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
  const f = await mount(submit);
  await act(async () => { button("Close all agents").click(); button("Close all agents").click(); });
  expect(submit).toHaveBeenCalledExactlyOnceWith("project-1", "run-1");
  expect(button("Keep open").disabled).toBe(true);
  expect(f.close).not.toHaveBeenCalled();
  await act(async () => host.querySelector(".dialog-layer")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(f.close).not.toHaveBeenCalled();
  await act(async () => resolve(undefined));
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("keeps a partial failure visible and permits retry without reopening the group", async () => {
  const f = await mount(vi.fn().mockResolvedValueOnce("One agent is busy").mockResolvedValueOnce(undefined));
  await act(async () => button("Close all agents").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("One agent is busy");
  expect(f.close).not.toHaveBeenCalled();
  await act(async () => button("Retry close").click());
  expect(f.submit).toHaveBeenCalledTimes(2); expect(f.close).toHaveBeenCalledTimes(1);
});
