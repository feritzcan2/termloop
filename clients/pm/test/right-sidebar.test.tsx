// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RIGHT_SIDEBAR,
  readRightSidebarPreference,
  toggleRightSidebar,
  writeRightSidebarPreference,
} from "../src/renderer/state/right-sidebar-preference.js";
import { RightActivityBar } from "../src/renderer/ui/RightActivityBar.js";
import { SprintSidebar } from "../src/renderer/ui/SprintSidebar.js";
import { SprintsPanel } from "../src/renderer/ui/SprintsPanel.js";
import { leftSprint, sprintPanelOrder } from "../src/renderer/ui/format.js";
import { boardTicket, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

const DAY = 24 * 60 * 60 * 1000;
const active = sprint({ id: "active", name: "Sprint 12", state: "active", activatedAtEpochMs: 10 * DAY });
const next = sprint({ id: "next", name: "Sprint 13", state: "planned", activatedAtEpochMs: null, createdAtEpochMs: 20 * DAY });
const later = sprint({ id: "later", name: "Sprint 14", state: "planned", activatedAtEpochMs: null, createdAtEpochMs: 30 * DAY });
const oldest = sprint({ id: "oldest", name: "Sprint 10", state: "closed", activatedAtEpochMs: 1 * DAY, closedAtEpochMs: 2 * DAY });
const newer = sprint({ id: "newer", name: "Sprint 11", state: "closed", activatedAtEpochMs: 5 * DAY, closedAtEpochMs: 6 * DAY });

describe("right sidebar preference", () => {
  it("closes the open view and opens any other one", () => {
    const sprints = { ...DEFAULT_RIGHT_SIDEBAR, open: true, view: "sprints" as const };
    expect(toggleRightSidebar(sprints, "sprints")).toMatchObject({ open: false, view: "sprints" });
    expect(toggleRightSidebar(sprints, "skills")).toMatchObject({ open: true, view: "skills" });
    expect(toggleRightSidebar({ ...sprints, open: false }, "sprints")).toMatchObject({ open: true, view: "sprints" });
    expect(toggleRightSidebar(sprints, "skills").width).toBe(sprints.width);
  });

  it("round-trips through storage, clamps the width, and falls back on bad or blocked storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    writeRightSidebarPreference({ open: false, view: "skills", width: 999 }, storage);
    expect(readRightSidebarPreference(storage)).toEqual({ open: false, view: "skills", width: 640 });
    writeRightSidebarPreference({ open: true, view: "playbook", width: 300 }, storage);
    expect(readRightSidebarPreference(storage)).toEqual({ open: true, view: "playbook", width: 300 });
    // The assistant moved into the stage; a remembered assistant panel opens Sprints.
    store.set([...store.keys()][0]!, JSON.stringify({ open: true, view: "assistant", width: 320 }));
    expect(readRightSidebarPreference(storage)).toEqual({ open: true, view: "sprints", width: 320 });
    store.set([...store.keys()][0]!, JSON.stringify({ open: "yes", view: "files", width: 10 }));
    expect(readRightSidebarPreference(storage)).toEqual({ open: DEFAULT_RIGHT_SIDEBAR.open, view: "sprints", width: 280 });
    store.set([...store.keys()][0]!, "{not json");
    expect(readRightSidebarPreference(storage)).toEqual(DEFAULT_RIGHT_SIDEBAR);
    const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readRightSidebarPreference(blocked)).toEqual(DEFAULT_RIGHT_SIDEBAR);
    expect(() => writeRightSidebarPreference(DEFAULT_RIGHT_SIDEBAR, blocked)).not.toThrow();
  });
});

describe("right activity bar", () => {
  it("marks only the open view pressed and reports every choice", () => {
    const onSelect = vi.fn();
    const onToggleSettings = vi.fn();
    const view = render(<RightActivityBar open view="sprints" onSelect={onSelect} settings={{ active: true, onToggle: onToggleSettings }} />);
    cleanup = view.unmount;
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>(".activity-bar button")];
    expect(buttons.map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([["Sprints", "true"], ["Playbook", "false"], ["Inbox", "false"], ["Skills", "false"], ["Settings", "true"]]);
    expect(buttons[4]!.classList.contains("bottom")).toBe(true);
    act(() => buttons[1]!.click());
    expect(onSelect).toHaveBeenLastCalledWith("playbook");
    act(() => buttons[2]!.click());
    expect(onSelect).toHaveBeenLastCalledWith("suggestions");
    act(() => buttons[3]!.click());
    expect(onSelect).toHaveBeenLastCalledWith("skills");
    // Settings switches the stage, not the right panel.
    act(() => buttons[4]!.click());
    expect(onToggleSettings).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(3);
  });
});

describe("left sprint rail", () => {
  it("shows the active sprint even when another sprint is focused, and falls back to the focused one", () => {
    expect(leftSprint([next, active], "next")?.id).toBe("active");
    expect(leftSprint([next, later], "later")?.id).toBe("later");
    expect(leftSprint([next], undefined)).toBeUndefined();

    const onCreateTicket = vi.fn();
    const view = render(
      <SprintSidebar
        sprints={[next, active, oldest]}
        tickets={[boardTicket({ id: "a", sprintId: "active", status: "done" }), { ...boardTicket({ id: "b", sprintId: "active", status: "todo" }), pendingProposalCount: 2 }]}
        tier="tickets"
        playbook={undefined}
        selectedSprintId="next"
        selectedTicketId={undefined}
        onSelectSprint={noop}
        onSelectTicket={noop}
        onCreateSprint={noop}
        onCreateTicket={onCreateTicket}
        onMoveTicket={noop}
      />,
    );
    cleanup = view.unmount;
    const head = view.container.querySelector(".group .ghead")!;
    expect(head.querySelector("strong")!.textContent).toBe("Sprint 12");
    expect(head.querySelector(".meta")!.textContent).toBe("1/2");
    expect(view.container.querySelector(".pm-other-sprints")!.textContent).toBe("Other sprints2");
    expect(view.container.textContent).not.toContain("Sprint 13");
    expect(view.container.querySelector(".row-line .draft-pill")!.textContent).toBe("2 drafts");
  });
});

describe("agents under tickets", () => {
  it("nests each agent under its focus ticket and reports a pick", () => {
    const onSelectAgent = vi.fn();
    const onStopAgent = vi.fn();
    const agent = (sessionId: string, focusTicketId: string | null) =>
      ({ sessionId, label: "Assistant", state: "running" as const, assistant: true, provider: "claude" as const, detail: "", focusTicketId });
    const view = render(
      <SprintSidebar
        sprints={[active]}
        tickets={[boardTicket({ id: "a", sprintId: "active", title: "Alpha" }), boardTicket({ id: "b", sprintId: "active", title: "Beta" })]}
        tier="tickets"
        playbook={undefined}
        selectedSprintId="active"
        selectedTicketId={undefined}
        agents={[agent("s1", "a"), agent("s2", "a"), agent("s3", null)]}
        shownAgentSessionId="s2"
        onSelectAgent={onSelectAgent}
        onStopAgent={onStopAgent}
        onSelectSprint={noop}
        onSelectTicket={noop}
        onCreateSprint={noop}
        onCreateTicket={noop}
        onMoveTicket={noop}
      />,
    );
    cleanup = view.unmount;
    const nested = [...view.container.querySelectorAll<HTMLElement>(".pm-ticket-agents")];
    expect(nested.map((list) => list.getAttribute("aria-label"))).toEqual(["Agents on Alpha"]);
    const rows = [...nested[0]!.querySelectorAll<HTMLButtonElement>(".pm-agent-row")];
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual([null, "true"]);
    act(() => rows[0]!.click());
    expect(onSelectAgent).toHaveBeenLastCalledWith("s1");
    const stops = [...nested[0]!.querySelectorAll<HTMLButtonElement>(".pm-agent-stop")];
    expect(stops).toHaveLength(2);
    act(() => stops[1]!.click());
    expect(onStopAgent).toHaveBeenLastCalledWith("s2");
    expect(onSelectAgent).toHaveBeenCalledTimes(1);
  });
});

describe("sprints panel", () => {
  it("orders active first, open sprints by start, then closed sprints latest first", () => {
    expect(sprintPanelOrder([oldest, later, newer, next, active]).map((entry) => entry.id)).toEqual(["active", "next", "later", "newer", "oldest"]);
  });

  it("lists sprints with done counts, focuses one on click, and activates planned ones", () => {
    const onSelectSprint = vi.fn();
    const onActivateSprint = vi.fn();
    const view = render(
      <SprintsPanel
        sprints={[later, oldest, next, active]}
        tickets={[boardTicket({ id: "a", sprintId: "active", status: "done" }), boardTicket({ id: "b", sprintId: null })]}
        selectedSprintId="next"
        now={12 * DAY}
        canCreate
        onSelectSprint={onSelectSprint}
        onActivateSprint={onActivateSprint}
        onCreateSprint={noop}
      />,
    );
    cleanup = view.unmount;
    const rows = [...view.container.querySelectorAll<HTMLButtonElement>(".sprint-row")];
    expect(rows.map((row) => [row.querySelector(".row-title")!.textContent, row.querySelector(".done")!.textContent])).toEqual([
      ["Sprint 12", "1/1"], ["Sprint 13", "0/0"], ["Sprint 14", "0/0"], ["Sprint 10", "0/0"],
    ]);
    expect(rows[1]!.getAttribute("aria-current")).toBe("true");
    expect(view.container.querySelector(".pm-no-sprint .row-sub")!.textContent).toBe("1 ticket");
    act(() => rows[2]!.click());
    expect(onSelectSprint).toHaveBeenLastCalledWith("later");
    const activate = [...view.container.querySelectorAll<HTMLButtonElement>(".pm-activate")];
    expect(activate).toHaveLength(2);
    act(() => activate[0]!.click());
    expect(onActivateSprint).toHaveBeenLastCalledWith("next");
  });
});
