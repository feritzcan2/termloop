// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { SprintSidebar } from "../src/renderer/ui/SprintSidebar.js";
import { dropTarget } from "../src/renderer/ui/sprint-dnd.js";
import { boardTicket, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;
const lane = [boardTicket({ id: "a", rank: 0 }), boardTicket({ id: "b", rank: 1 }), boardTicket({ id: "c", rank: 2 })];

describe("sprint sidebar moves", () => {
  it("opens a ticket's actions and its moves on right-click", () => {
    const addNote = vi.fn();
    const onMoveTicket = vi.fn();
    const { container, unmount } = render(
      <SprintSidebar
        sprints={[sprint()]}
        tickets={lane}
        tier="tickets"
        selectedSprintId="sprint-1"
        selectedTicketId={undefined}
        onSelectSprint={noop}
        onSelectTicket={noop}
        onCreateSprint={noop}
        onCreateTicket={noop}
        onMoveTicket={onMoveTicket}
        ticketActions={(id) => [{ kind: "action", label: "Add note…", run: () => addNote(id) }]}
      />,
    );
    const row = container.querySelectorAll<HTMLButtonElement>(".pm-ticket-head > .row")[1]!;
    act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 })); });
    const menu = container.querySelector<HTMLElement>(".pm-context-menu")!;
    const labels = [...menu.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toEqual(["Add note…", "Move up", "Move down", "Remove from sprint"]);
    expect(menu.querySelector("hr.pm-menu-sep")).not.toBeNull();
    act(() => menu.querySelector<HTMLButtonElement>("button")!.click());
    expect(addNote).toHaveBeenCalledWith("b");
    expect(container.querySelector(".pm-context-menu")).toBeNull();
    unmount();
  });

  it("turns a drop into a reorder within the lane or a move to another lane", () => {
    expect(dropTarget("a", "c", lane, "sprint-1")).toEqual({ sprintId: "sprint-1", index: 2 });
    expect(dropTarget("c", "a", lane, "sprint-1")).toEqual({ sprintId: "sprint-1", index: 0 });
    expect(dropTarget("a", "lane:sprint-2", lane, "sprint-1")).toEqual({ sprintId: "sprint-2" });
    expect(dropTarget("a", "lane:none", lane, "sprint-1")).toEqual({ sprintId: null });
    expect(dropTarget("a", "lane:sprint-1", lane, "sprint-1")).toBeUndefined();
    expect(dropTarget("a", "a", lane, "sprint-1")).toBeUndefined();
    expect(dropTarget("a", undefined, lane, "sprint-1")).toBeUndefined();
  });

  it("takes the status of a ticket dropped on in another status section", () => {
    const mixed = [boardTicket({ id: "a", rank: 0, status: "todo" }), boardTicket({ id: "b", rank: 1, status: "done" })];
    expect(dropTarget("a", "b", mixed, "sprint-1")).toEqual({ sprintId: "sprint-1", index: 1, status: "done" });
    expect(dropTarget("b", "lane:sprint-2", mixed, "sprint-1")).toEqual({ sprintId: "sprint-2" });
  });

  it("groups the focused sprint into status sections and keeps move up/down inside one", () => {
    const onMoveTicket = vi.fn();
    const tickets = [
      boardTicket({ id: "a", rank: 0, status: "done", title: "A" }),
      boardTicket({ id: "b", rank: 1, status: "todo", title: "B" }),
      boardTicket({ id: "c", rank: 2, status: "done", title: "C" }),
    ];
    const { container, unmount } = render(
      <SprintSidebar
        sprints={[sprint()]}
        tickets={tickets}
        tier="tickets"
        selectedSprintId="sprint-1"
        selectedTicketId={undefined}
        onSelectSprint={noop}
        onSelectTicket={noop}
        onCreateSprint={noop}
        onCreateTicket={noop}
        onMoveTicket={onMoveTicket}
      />,
    );
    const items = [...container.querySelectorAll(".group .list > li")].map((item) =>
      item.classList.contains("pm-status-head") ? `# ${item.textContent}` : item.querySelector(".row-title")!.textContent);
    expect(items).toEqual(["# To do1", "SHOP-7B", "# Done2", "SHOP-7A", "SHOP-7C"]);
    const menuOf = (index: number) => {
      act(() => container.querySelectorAll<HTMLButtonElement>(".pm-move-menu > button")[index]!.click());
      return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    };
    const b = menuOf(0);
    expect([b[0]!.disabled, b[1]!.disabled]).toEqual([true, true]);
    act(() => container.querySelectorAll<HTMLButtonElement>(".pm-move-menu > button")[0]!.click());
    const a = menuOf(1);
    act(() => a[1]!.click());
    expect(onMoveTicket).toHaveBeenLastCalledWith("a", "sprint-1", 2);
    unmount();
  });

  it("offers move up, move down, and other sprints from each ticket's menu", () => {
    const onMoveTicket = vi.fn();
    const { container, unmount } = render(
      <SprintSidebar
        sprints={[sprint(), sprint({ id: "sprint-2", name: "Sprint 13", state: "planned" }), sprint({ id: "old", name: "Old", state: "closed" })]}
        tickets={lane}
        tier="tickets"
        selectedSprintId="sprint-1"
        selectedTicketId={undefined}
        onSelectSprint={noop}
        onSelectTicket={noop}
        onCreateSprint={noop}
        onCreateTicket={noop}
        onMoveTicket={onMoveTicket}
      />,
    );
    const menuOf = (index: number) => {
      const toggle = container.querySelectorAll<HTMLButtonElement>(".pm-move-menu > button")[index]!;
      act(() => toggle.click());
      return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    };
    const first = menuOf(0);
    expect(first.map((item) => item.textContent)).toEqual(["Move up", "Move down", "Move to Sprint 13", "Remove from sprint"]);
    expect(first[0]!.disabled).toBe(true);
    act(() => first[1]!.click());
    expect(onMoveTicket).toHaveBeenLastCalledWith("a", "sprint-1", 1);
    const middle = menuOf(1);
    act(() => middle[0]!.click());
    expect(onMoveTicket).toHaveBeenLastCalledWith("b", "sprint-1", 0);
    const last = menuOf(2);
    act(() => last[2]!.click());
    expect(onMoveTicket).toHaveBeenLastCalledWith("c", "sprint-2");
    unmount();
  });
});
