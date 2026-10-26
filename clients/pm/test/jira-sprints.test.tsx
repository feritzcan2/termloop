// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmJiraBoardSprint } from "@termloop/pm-contract/pm";
import { JiraSprintsSection, type JiraSprintsSectionProps, filterBoards } from "../src/renderer/ui/JiraSprintsSection.js";
import { SprintOverview } from "../src/renderer/ui/SprintOverview.js";
import type { JiraSprintsView } from "../src/renderer/ui/types.js";
import { playbook, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);

function jiraSprint(overrides: Partial<PmJiraBoardSprint>): PmJiraBoardSprint {
  return { jiraSprintId: 1, name: "UK Sprint 23", state: "active", startEpochMs: null, endEpochMs: null, sprintId: null, ...overrides };
}

function view(overrides: Partial<JiraSprintsView>): JiraSprintsView {
  return { loading: false, sprints: undefined, boards: undefined, error: undefined, importing: undefined, ...overrides };
}

function section(props: Partial<JiraSprintsSectionProps>) {
  const rendered = render(
    <JiraSprintsSection connected boardId={310} view={undefined} sprints={[]} onLoad={noop} onSetBoard={noop} onImport={noop}
      onSelectSprint={noop} onOpenSettings={noop} {...props} />,
  );
  cleanup = rendered.unmount;
  return rendered.container;
}

describe("Jira sprints", () => {
  it("points to Settings without Jira, and reads Jira once it is connected", () => {
    const onOpenSettings = vi.fn();
    const onLoad = vi.fn();
    let container = section({ connected: false, onOpenSettings, onLoad });
    act(() => button(container, "Open Settings")!.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onLoad).not.toHaveBeenCalled();
    cleanup?.();
    container = section({ onLoad });
    expect(onLoad).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Reading Jira");
  });

  it("chooses a board from the boards Jira lists", () => {
    const onSetBoard = vi.fn();
    const boards = { projectId: "p1", truncated: false, boards: [{ id: 310, name: "UK Team", kind: "scrum", location: "Nucleus" }] };
    const container = section({ boardId: null, view: view({ boards }), onSetBoard });
    const row = container.querySelector<HTMLButtonElement>(".jira-board-row")!;
    expect(row.textContent).toContain("scrum · Nucleus · #310");
    act(() => row.click());
    expect(onSetBoard).toHaveBeenCalledWith(310);
  });

  it("imports a new sprint, syncs an imported one, and opens it", () => {
    const onImport = vi.fn();
    const onSelectSprint = vi.fn();
    const sprints = {
      projectId: "p1", boardId: 310, sprintsSupported: true, truncated: false,
      sprints: [
        jiraSprint({ jiraSprintId: 7919, sprintId: "s1", startEpochMs: Date.UTC(2026, 9, 13, 12), endEpochMs: Date.UTC(2026, 9, 27, 12) }),
        jiraSprint({ jiraSprintId: 7920, name: "UK Sprint 24", state: "future" }),
      ],
    };
    const container = section({ view: view({ sprints }), sprints: [sprint({ id: "s1", jiraSprintId: 7919 })], onImport, onSelectSprint });
    const rows = [...container.querySelectorAll<HTMLElement>(".jira-sprint-item")];
    expect(rows.map((row) => row.querySelector(".row-title")!.textContent)).toEqual(["UK Sprint 23", "UK Sprint 24"]);
    expect(rows[0]!.querySelector(".row-sub")!.textContent).toMatch(/^active · .+ – .+$/);
    act(() => button(rows[0]!, "Sync")!.click());
    act(() => button(rows[1]!, "Import")!.click());
    expect(onImport.mock.calls).toEqual([[7919], [7920]]);
    act(() => rows[0]!.querySelector<HTMLButtonElement>(".row")!.click());
    expect(onSelectSprint).toHaveBeenCalledWith("s1");
    expect(rows[1]!.querySelector<HTMLButtonElement>(".row")!.disabled).toBe(true);
  });

  it("filters boards by every typed word and lists the current board first", () => {
    const boards = [
      { id: 27, name: "AD Board", location: "ANPR DE" },
      { id: 310, name: "UK Team", location: "Azure Nucleus" },
      { id: 311, name: "UK Ops", location: null },
    ];
    expect(filterBoards(boards, "", 311).map((board) => board.id)).toEqual([311, 27, 310]);
    expect(filterBoards(boards, "uk nucleus", null).map((board) => board.id)).toEqual([310]);
    expect(filterBoards(boards, "27", null).map((board) => board.id)).toEqual([27]);
  });

  it("says when a board has no sprints", () => {
    const sprints = { projectId: "p1", boardId: 310, sprintsSupported: false, truncated: false, sprints: [] };
    expect(section({ view: view({ sprints }) }).textContent).toContain("This board has no sprints");
  });

  it("offers no Delete for an open sprint Jira owns", () => {
    const owned = sprint({ jiraSprintId: 7919, jiraBoardId: 310 });
    const overview = (jiraBoardId: number | null) => {
      const rendered = render(
        <SprintOverview sprint={owned} sprints={[owned]} tickets={[]} tier="tickets" playbook={playbook()} digest={[]} now={0}
          onOpenTicket={noop} onActivate={noop} onClose={noop} onDelete={noop} jiraBoardId={jiraBoardId} />,
      );
      cleanup = rendered.unmount;
      return rendered.container;
    };
    let container = overview(310);
    expect(button(container, "Delete sprint")).toBeUndefined();
    expect(container.querySelector(".pane-head .chip")?.textContent).toBe("Jira");
    cleanup?.();
    // Once sprints come from another board, the old mirror is the PM's to delete.
    container = overview(311);
    expect(button(container, "Delete sprint")).toBeDefined();
  });
});
