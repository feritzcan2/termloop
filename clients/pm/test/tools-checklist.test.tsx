// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PmToolsReadResult } from "@termloop/pm-contract/pm";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { SettingsPage } from "../src/renderer/ui/SettingsPage.js";
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

describe("ToolsChecklist", () => {
  it("reads the cached checklist when shown and groups it by kind", async () => {
    const onRead = vi.fn(async () => undefined);
    const unread = render(<ToolsChecklist tools={undefined} now={0} onRead={onRead} />);
    expect(onRead).toHaveBeenCalledWith(false);
    unread.unmount();

    onRead.mockClear();
    const { container, unmount } = render(<ToolsChecklist tools={TOOLS} now={0} onRead={onRead} />);
    expect(onRead).not.toHaveBeenCalled();
    const groups = [...container.querySelectorAll("section.tool-group")].map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Project sources", "Command-line tools", "Claude account connectors"]);
    const marks = [...container.querySelectorAll(".tool-mark")].map((mark) => mark.getAttribute("aria-label"));
    expect(marks).toEqual(["Ready", "Needs setup", "Missing", "Unknown"]);
    unmount();
  });

  it("checks the machine again on Check again", async () => {
    const onRead = vi.fn(async () => undefined);
    const { container, unmount } = render(<ToolsChecklist tools={TOOLS} now={0} onRead={onRead} />);
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Check again")!.click());
    expect(onRead).toHaveBeenCalledWith(true);
    unmount();
  });
});

describe("Settings Tools section", () => {
  it("shows the checklist with its ready count in Settings", () => {
    const { container, unmount } = render(<SettingsPage {...settingsProps()} />);
    const section = container.querySelector('section.settings-section[aria-label="Tools"]')!;
    expect(section.textContent).toContain("1 OF 4 READY");
    expect(section.querySelectorAll(".tool-row")).toHaveLength(4);
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

function settingsProps() {
  const noop = () => undefined;
  return {
    projectName: "Shop", settings: undefined, catalog: undefined, sources: undefined, tracking: undefined, environments: [], probes: [],
    tools: TOOLS, now: 0, onReadTools: async () => undefined, onSaveSources: async () => true, onClearToken: noop, onSaveSettings: noop,
    onSetEnvironments: noop, onCreateProbe: noop, onApproveProbe: noop, onRejectProbe: noop, onDeleteProbe: noop,
  };
}
