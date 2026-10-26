// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmEpic, PmEpicBreakdown } from "@termloop/pm-contract/pm";
import { EpicsPanel, type EpicsPanelProps } from "../src/renderer/ui/EpicsPanel.js";
import { boardTicket, sprint } from "./fixtures.js";
import { render } from "./render.js";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

const epic: PmEpic = { id: "epic-1", projectId: "project-1", title: "Checkout", description: "Pay by card", createdAtEpochMs: 0, updatedAtEpochMs: 0 };
const breakdown: PmEpicBreakdown = {
  id: "breakdown-1", projectId: "project-1", epicId: null, epic: { title: "Refunds", description: "" },
  tasks: [
    { title: "Refund API", description: "", acceptanceCriteria: ["Refunds the card"] },
    { title: "Refund button", description: "", acceptanceCriteria: [] },
    { title: "Refund email", description: "", acceptanceCriteria: [] },
  ],
  summary: "Split by layer", createdAtEpochMs: 0,
};

function panel(overrides: Partial<EpicsPanelProps> = {}) {
  const props: EpicsPanelProps = {
    epics: [epic], breakdowns: [breakdown],
    tickets: [boardTicket({ id: "t1", epicId: "epic-1", status: "done" }), boardTicket({ id: "t2", epicId: "epic-1", status: "todo" }), boardTicket({ id: "t3", epicId: null })],
    sprints: [sprint({ id: "active", name: "Sprint 12", state: "active" }), sprint({ id: "old", name: "Sprint 9", state: "closed" })],
    canCreate: true,
    onCreate: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onPlan: vi.fn(), onOpenTicket: vi.fn(),
    onAccept: vi.fn(async () => true), onReject: vi.fn(),
    ...overrides,
  };
  const view = render(<EpicsPanel {...props} />);
  cleanup = view.unmount;
  return { ...view, props };
}

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text)!;

describe("epics panel", () => {
  it("shows an epic's progress from its own tickets only", () => {
    const { container } = panel();
    expect(container.querySelector(".epic-head .done")?.textContent).toBe("1/2");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
  });

  it("creates only the kept tasks of a breakdown, in the chosen open sprint", () => {
    const { container, props } = panel();
    const options = [...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Sprint for the new tickets"] option')].map((option) => option.value);
    expect(options).toEqual(["", "active"]);
    const boxes = container.querySelectorAll<HTMLInputElement>(".breakdown-tasks input[type=checkbox]");
    act(() => boxes[1]!.click());
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Sprint for the new tickets"]')!;
    act(() => {
      select.value = "active";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => button(container, "Create 2 tickets").click());
    expect(props.onAccept).toHaveBeenCalledWith("breakdown-1", [0, 2], "active");
  });

  it("asks before deleting an epic and plans tasks for it through the assistant", () => {
    const { container, props } = panel({ breakdowns: [] });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Expand Checkout"]')!.click());
    act(() => button(container, "Plan tasks").click());
    expect(props.onPlan).toHaveBeenCalledWith("epic-1");
    act(() => button(container, "Delete").click());
    expect(props.onDelete).not.toHaveBeenCalled();
    act(() => button(container, "Delete epic").click());
    expect(props.onDelete).toHaveBeenCalledWith("epic-1");
  });
});
