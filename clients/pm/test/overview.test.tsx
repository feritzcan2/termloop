// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SprintOverview, standupNote } from "../src/renderer/ui/SprintOverview.js";
import { boardTicket, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;

describe("sprint overview", () => {
  it("lists a ticket with several risks once and counts tickets, not risks", () => {
    const risky = boardTicket({ id: "t1" }, {
      risks: [
        { kind: "mergedNotDeployed", detail: "Merged 3 days ago", sinceEpochMs: null },
        { kind: "stuckInStatus", detail: "No change for 5 days", sinceEpochMs: null },
      ],
    });
    const { container, unmount } = render(
      <SprintOverview sprint={sprint()} sprints={[sprint()]} tickets={[risky, boardTicket({ id: "t2" })]} tier="tickets"
        digest={[]} now={0} onOpenTicket={noop} onActivate={noop} onClose={noop} />,
    );
    const rows = container.querySelectorAll(".pm-table tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Merged 3 days ago; No change for 5 days");
    const atRisk = [...container.querySelectorAll(".pm-counter")].find((counter) => counter.textContent?.includes("At risk"));
    expect(atRisk?.querySelector(".pm-counter-value")?.textContent).toBe("1");
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
