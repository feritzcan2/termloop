// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SprintOverview, boardFilter, standupNote } from "../src/renderer/ui/SprintOverview.js";
import { boardTicket, playbook, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;

describe("sprint overview", () => {
  it("places each ticket in its step's column as a card with its risks", () => {
    const risky = boardTicket({ id: "t1", title: "Risky" }, {
      risks: [
        { kind: "stepBlocked", detail: "Merged 3 days ago", sinceEpochMs: null },
        { kind: "stuckInStatus", detail: "No change for 5 days", sinceEpochMs: null },
      ],
    });
    const fresh = boardTicket({ id: "t2", title: "Fresh", jiraUrl: null }, { playbook: { position: null, steps: [] } });
    const { container, unmount } = render(
      <SprintOverview sprint={sprint()} sprints={[sprint()]} tickets={[risky, fresh]} tier="tickets"
        playbook={playbook()} digest={[]} now={0} onOpenTicket={noop} onActivate={noop} onClose={noop} onDelete={noop} jiraBoardId={null} />,
    );
    const columns = [...container.querySelectorAll(".board-col")];
    expect(columns.map((column) => column.querySelector(".board-col-head")!.textContent)).toEqual(["Not started1", "In progress0", "In review0", "Merged1", "Live0", "Done0"]);
    expect(columns[0]!.querySelector(".board-card-title")?.textContent).toBe("Fresh");
    const card = columns[3]!.querySelector(".board-card")!;
    expect(card.querySelector(".board-card-title")?.textContent).toBe("Risky");
    expect([...card.querySelectorAll(".risk")].map((element) => element.textContent)).toEqual(["step blocked", "stuck in status"]);
    expect(card.querySelector(".k")?.textContent).toBe("SHOP-7");
    unmount();
  });

  it("falls back to status columns without a Playbook", () => {
    const { container, unmount } = render(
      <SprintOverview sprint={sprint()} sprints={[sprint()]} tickets={[boardTicket({ status: "inReview" })]} tier="tickets"
        playbook={undefined} digest={[]} now={0} onOpenTicket={noop} onActivate={noop} onClose={noop} onDelete={noop} jiraBoardId={null} />,
    );
    const heads = [...container.querySelectorAll(".board-col-head")].map((element) => element.textContent);
    expect(heads).toEqual(["To do0", "In progress0", "In review1", "Done0"]);
    unmount();
  });

  it("filters the board by text and by assignee", () => {
    const tickets = [
      boardTicket({ id: "a1", title: "Login", assignee: "Ada Lovelace", jiraUrl: null }),
      boardTicket({ id: "b1", title: "Cart", assignee: "bob", jiraUrl: null }),
    ];
    expect(boardFilter(tickets, "log", undefined).map((entry) => entry.ticket.id)).toEqual(["a1"]);
    expect(boardFilter(tickets, "#b1", undefined).map((entry) => entry.ticket.id)).toEqual(["b1"]);
    expect(boardFilter(tickets, "", "bob").map((entry) => entry.ticket.id)).toEqual(["b1"]);
    const { container, unmount } = render(
      <SprintOverview sprint={sprint()} sprints={[sprint()]} tickets={tickets} tier="tickets"
        playbook={playbook()} digest={[]} now={0} onOpenTicket={noop} onActivate={noop} onClose={noop} onDelete={noop} jiraBoardId={null} />,
    );
    expect([...container.querySelectorAll(".board-people .avatar")].map((element) => element.textContent)).toEqual(["AL", "B"]);
    unmount();
  });

  it("groups the standup note per assignee into done, in progress, and blocked", () => {
    const note = standupNote(sprint(), [
      boardTicket({ id: "a1", title: "Login", assignee: "ada", status: "done", jiraUrl: null }),
      boardTicket({ id: "a2", title: "Cart", assignee: "ada", status: "inReview", jiraUrl: null }),
      boardTicket({ id: "b1", title: "Search", assignee: "bob", status: "inProgress", jiraUrl: null, blockers: [{ id: "x", text: "Waiting on API" }] }),
      boardTicket({ id: "u1", title: "Docs", assignee: null, status: "inProgress", jiraUrl: null }),
      boardTicket({ id: "u2", title: "Later", assignee: null, status: "todo", jiraUrl: null }),
    ], []);
    const lines = note.split("\n");
    const section = (name: string) => lines.slice(lines.indexOf(`${name}:`) + 1, lines.indexOf("", lines.indexOf(`${name}:`)));
    expect(lines.filter((line) => line.endsWith(":") && !line.startsWith(" "))).toEqual(["ada:", "bob:", "Unassigned:"]);
    expect(section("ada").map((line) => line.trim())).toEqual(["Done (1):", expect.stringContaining("Login"), "In progress (1):", expect.stringContaining("Cart")]);
    expect(section("bob").map((line) => line.trim())).toEqual(["Blocked (1):", expect.stringContaining("Search: Waiting on API")]);
    expect(note).not.toContain("Later");
  });
});
