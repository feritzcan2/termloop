// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PmToolsReadResult } from "@termloop/pm-contract/pm";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { ToolsChecklist } from "../src/renderer/ui/ToolsChecklist.js";
import { fakeBridge, ok } from "./fixtures.js";
import { render } from "./render.js";

const TOOLS: PmToolsReadResult = {
  projectId: "project-1",
  readAtEpochMs: 0,
  tools: [
    { kind: "source", name: "Jira", state: "ready", detail: "Connected with a board." },
    { kind: "cli", name: "az", state: "needsSetup", detail: "Installed 2.70.0, not logged in." },
    { kind: "cli", name: "aws", state: "missing", detail: "Not installed." },
    { kind: "connector", name: "Slack", state: "unknown", detail: "Connected to your Claude account before." },
  ],
};

const open = (container: HTMLElement) => act(() => {
  const details = container.querySelector<HTMLDetailsElement>("details.tools-checklist")!;
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
});

describe("ToolsChecklist", () => {
  it("reads the cached checklist on first open and groups it by kind", async () => {
    const onRead = vi.fn(async () => undefined);
    const closed = render(<ToolsChecklist tools={undefined} now={0} onRead={onRead} />);
    expect(onRead).not.toHaveBeenCalled();
    open(closed.container);
    expect(onRead).toHaveBeenCalledWith(false);
    closed.unmount();

    const { container, unmount } = render(<ToolsChecklist tools={TOOLS} now={0} onRead={onRead} />);
    expect(container.textContent).toContain("1 of 4 ready");
    const groups = [...container.querySelectorAll("section.tool-group")].map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Project sources", "Command-line tools", "Claude account connectors"]);
    const marks = [...container.querySelectorAll(".tool-mark")].map((mark) => mark.getAttribute("aria-label"));
    expect(marks).toEqual(["Ready", "Needs setup", "Missing", "Unknown"]);
    unmount();
  });

  it("checks the machine again on Check again", async () => {
    const onRead = vi.fn(async () => undefined);
    const { container, unmount } = render(<ToolsChecklist tools={TOOLS} now={0} onRead={onRead} />);
    open(container);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Check again")!.click());
    expect(onRead).toHaveBeenCalledWith(true);
    unmount();
  });
});

describe("PmController.loadTools", () => {
  it("reads the checklist for the open project", async () => {
    const bridge = fakeBridge((method) => (method === "pm_tools_read" ? ok(TOOLS) : ok({})));
    const store = createPmStore({ projectId: "project-1" });
    await new PmController(bridge, store).loadTools(true);
    expect(bridge.calls).toEqual([{ method: "pm_tools_read", params: { projectId: "project-1", refresh: true } }]);
    expect(store.getState().tools).toEqual(TOOLS);
  });
});
