// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoubleShiftDetector, isNewTicketShortcut } from "../src/renderer/composition/capture-shortcut.js";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { QuickCapture } from "../src/renderer/ui/QuickCapture.js";
import type { TicketCapture } from "../src/renderer/ui/types.js";
import { fakeBridge, ok, sprint, ticket } from "./fixtures.js";
import { render, typeInto } from "./render.js";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

const down = (code: string, timeStamp: number, extra: Partial<KeyboardEvent> = {}) =>
  ({ code, timeStamp, altKey: false, ctrlKey: false, metaKey: false, repeat: false, ...extra });

describe("double Shift detection", () => {
  it("opens on two Shift taps within the window", () => {
    const detector = new DoubleShiftDetector(500);
    expect(detector.keyDown(down("ShiftLeft", 0))).toBe(false);
    detector.keyUp({ code: "ShiftLeft", timeStamp: 80 });
    expect(detector.keyDown(down("ShiftRight", 300))).toBe(true);
  });

  it("does not open when another key comes between the taps", () => {
    const detector = new DoubleShiftDetector(500);
    detector.keyDown(down("ShiftLeft", 0));
    expect(detector.keyDown(down("KeyA", 50))).toBe(false);
    detector.keyUp({ code: "ShiftLeft", timeStamp: 80 });
    expect(detector.keyDown(down("ShiftLeft", 200))).toBe(false);
  });

  it("does not open when the taps are 600 ms apart, or on a held or modified Shift", () => {
    const detector = new DoubleShiftDetector(500);
    detector.keyDown(down("ShiftLeft", 0));
    detector.keyUp({ code: "ShiftLeft", timeStamp: 80 });
    expect(detector.keyDown(down("ShiftLeft", 600))).toBe(false);
    detector.keyDown(down("ShiftLeft", 1000));
    expect(detector.keyDown(down("ShiftLeft", 1100, { repeat: true }))).toBe(false);
    detector.keyDown(down("ShiftLeft", 2000));
    detector.keyUp({ code: "ShiftLeft", timeStamp: 2050 });
    expect(detector.keyDown(down("ShiftLeft", 2100, { metaKey: true }))).toBe(false);
  });

  it("matches Cmd+N on macOS and Ctrl+N elsewhere only", () => {
    const key = (extra: Partial<KeyboardEvent>) => ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key: "n", ...extra });
    expect(isNewTicketShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isNewTicketShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isNewTicketShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isNewTicketShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isNewTicketShortcut(key({ metaKey: true, key: "m" }), true)).toBe(false);
  });
});

describe("quick capture overlay", () => {
  const sprints = [sprint({ id: "s-active", name: "Sprint 12", state: "active" }), sprint({ id: "s-next", name: "Sprint 13", state: "planned" }), sprint({ id: "s-old", name: "Sprint 9", state: "closed" })];

  function mount(onCreate: (capture: TicketCapture) => Promise<boolean>) {
    const onClose = vi.fn();
    const view = render(<QuickCapture sprints={sprints} defaultSprintId="s-active" assignees={["ada"]} canAskAssistant onCreate={onCreate} onClose={onClose} />);
    cleanup = view.unmount;
    const title = view.container.querySelector<HTMLInputElement>("input[aria-label='Ticket title']")!;
    const sprintSelect = view.container.querySelector<HTMLSelectElement>("select[aria-label='Sprint']")!;
    return { view, onClose, title, sprintSelect };
  }
  const press = async (target: HTMLElement, key: string, shiftKey = false) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })); });
  };

  it("lists open sprints plus the backlog, and creates in the chosen sprint on Enter, then closes", async () => {
    const onCreate = vi.fn(async () => true);
    const { onClose, title, sprintSelect } = mount(onCreate);
    expect([...sprintSelect.options].map((option) => option.value)).toEqual(["s-active", "s-next", ""]);
    act(() => { sprintSelect.value = "s-next"; sprintSelect.dispatchEvent(new Event("change", { bubbles: true })); });
    typeInto(title, "Fix checkout");
    await press(title, "Enter");
    expect(onCreate).toHaveBeenCalledWith({ title: "Fix checkout", sprintId: "s-next", priority: "medium", assignee: "", askAssistant: true });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the overlay open with a cleared title on Shift+Enter, and closes on Escape", async () => {
    const onCreate = vi.fn(async () => true);
    const { onClose, title } = mount(onCreate);
    typeInto(title, "First");
    await press(title, "Enter", true);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(title.value).toBe("");
    await press(title, "Escape");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the title when creation fails and ignores an empty title", async () => {
    const onCreate = vi.fn(async () => false);
    const { onClose, title } = mount(onCreate);
    await press(title, "Enter");
    expect(onCreate).not.toHaveBeenCalled();
    typeInto(title, "Retry me");
    await press(title, "Enter");
    expect(title.value).toBe("Retry me");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("PmController.captureTicket", () => {
  const board = { projectId: "project-1", sprints: [], tickets: [], environments: [], probes: [], runningChecks: [], tracking: { jira: false, code: false, deploy: false, tier: "tickets" } };

  it("creates with sprint, priority and assignee, stays on the current view, and asks an assistant about the ticket", async () => {
    const bridge = fakeBridge((method) => {
      if (method === "pm_ticket_create") return ok(ticket({ id: "ticket-9" }));
      if (method === "pm_board_read") return ok(board);
      if (method === "pm_agent_launch") return ok({ sessionId: "00000000-0000-0000-0000-000000000001" });
      if (method === "pm_agent_list") return ok({ sessions: [] });
      return ok({});
    });
    const store = createPmStore({ projectId: "project-1", view: "overview" });
    const controller = new PmController(bridge, store);
    const created = await controller.captureTicket({ title: " Fix ", sprintId: "s-next", priority: "high", assignee: " ada ", askAssistant: true });
    expect(created?.id).toBe("ticket-9");
    expect(bridge.calls.find((call) => call.method === "pm_ticket_create")?.params).toEqual({ projectId: "project-1", title: "Fix", sprintId: "s-next", priority: "high", assignee: "ada" });
    expect(bridge.calls.find((call) => call.method === "pm_agent_launch")?.params).toEqual({ projectId: "project-1", focusTicketId: "ticket-9" });
    expect(store.getState().view).toBe("overview");
  });

  it("files a backlog ticket without an assistant when not asked", async () => {
    const bridge = fakeBridge((method) => method === "pm_ticket_create" ? ok(ticket({ id: "ticket-9" })) : ok(board));
    const controller = new PmController(bridge, createPmStore({ projectId: "project-1" }));
    await controller.captureTicket({ title: "Later", sprintId: null, priority: "medium", assignee: "", askAssistant: false });
    expect(bridge.calls.find((call) => call.method === "pm_ticket_create")?.params).toEqual({ projectId: "project-1", title: "Later", priority: "medium" });
    expect(bridge.calls.map((call) => call.method)).not.toContain("pm_agent_launch");
  });
});
