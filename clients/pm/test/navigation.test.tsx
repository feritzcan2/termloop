// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PmController } from "../src/renderer/composition/pm-controller.js";
import { createPmStore } from "../src/renderer/state/presentation-store.js";
import { Sidebar, type SidebarProps } from "../src/renderer/ui/Sidebar.js";
import { SprintOverview } from "../src/renderer/ui/SprintOverview.js";
import type { AgentTab } from "../src/renderer/ui/types.js";
import { boardTicket, fakeBridge, ok, sprint } from "./fixtures.js";
import { render } from "./render.js";

const noop = () => undefined;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

const agent = (sessionId: string, label: string): AgentTab => ({
  sessionId, label, state: "running", assistant: false, provider: "claude", detail: "delivery check", focusTicketId: null,
});

function sidebar(overrides: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    projects: [{ id: "p1", name: "Shop", folder: null, createdAtEpochMs: 0 } as SidebarProps["projects"][number]],
    projectId: "p1",
    onSelectProject: noop,
    onCreateProject: noop,
    view: "overview",
    hasProject: true,
    boardSprint: "Sprint 12",
    counts: { sprints: 2, epics: 0, skills: 3 },
    jira: { configured: false, connected: false, status: "Jira not connected", lastPullEpochMs: undefined },
    pulling: false,
    now: 0,
    steward: undefined,
    agents: [],
    activeAgentSessionId: undefined,
    onNavigate: noop,
    onNewTicket: noop,
    onPull: noop,
    onOpenSteward: noop,
    onSelectAgent: noop,
    onStopAgent: noop,
    width: 232,
    widthBounds: { min: 200, max: 360, defaultWidth: 232 },
    onResize: noop,
    ...overrides,
  };
  const view = render(<Sidebar {...props} />);
  cleanup = view.unmount;
  return view.container;
}

describe("left navigation", () => {
  it("lists the board and pages, marks the current one, and navigates", () => {
    const onNavigate = vi.fn();
    const container = sidebar({ view: "epics", onNavigate });
    const items = [...container.querySelectorAll<HTMLButtonElement>(".nav-item")];
    expect(items.map((item) => item.querySelector(".nav-label")!.textContent)).toEqual(["Board", "Sprints", "Epics", "Jira issues", "Playbook", "Skills", "Settings"]);
    expect(items[0]!.querySelector(".nav-sub")!.textContent).toBe("Sprint 12");
    expect(items[1]!.querySelector(".nav-count")!.textContent).toBe("2");
    // An empty count shows no badge.
    expect(items[2]!.querySelector(".nav-count")).toBeNull();
    expect(items.filter((item) => item.getAttribute("aria-current") === "page")).toEqual([items[2]]);
    act(() => items[1]!.click());
    expect(onNavigate).toHaveBeenLastCalledWith("sprints");
    act(() => items[6]!.click());
    expect(onNavigate).toHaveBeenLastCalledWith("settings");
  });

  it("disables Jira issues until Jira is connected", () => {
    const jira = (connected: boolean) => [...sidebar({ jira: { configured: connected, connected, status: "", lastPullEpochMs: undefined } })
      .querySelectorAll<HTMLButtonElement>(".nav-item")][3]!;
    const off = jira(false);
    expect(off.disabled).toBe(true);
    expect(off.title).toBe("Connect Jira in Settings");
    cleanup?.();
    expect(jira(true).disabled).toBe(false);
  });

  it("disables every page without a project", () => {
    const container = sidebar({ hasProject: false, projectId: undefined });
    expect([...container.querySelectorAll<HTMLButtonElement>(".nav-item")].every((item) => item.disabled)).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".new-ticket")!.disabled).toBe(true);
  });

  it("always offers Steward and lists the other running agents", () => {
    const onOpenSteward = vi.fn();
    const onSelectAgent = vi.fn();
    const onNewTicket = vi.fn();
    const container = sidebar({ agents: [agent("s2", "Check SHOP-7")], view: "agent", activeAgentSessionId: "s2", onOpenSteward, onSelectAgent, onNewTicket });
    const rows = [...container.querySelectorAll<HTMLElement>('[aria-label="Agents"] .row')];
    expect(rows.map((row) => row.querySelector(".row-title")!.textContent)).toEqual(["Steward", "Check SHOP-7"]);
    expect(rows[1]!.classList.contains("active")).toBe(true);
    act(() => rows[0]!.click());
    expect(onOpenSteward).toHaveBeenCalled();
    act(() => rows[1]!.click());
    expect(onSelectAgent).toHaveBeenCalledWith("s2");
    act(() => container.querySelector<HTMLButtonElement>(".new-ticket")!.click());
    expect(onNewTicket).toHaveBeenCalled();
  });
});

describe("board sprint picker", () => {
  it("switches the board between sprints, active first", () => {
    const onSelectSprint = vi.fn();
    const view = render(
      <SprintOverview
        sprint={sprint({ id: "a", name: "Sprint 12" })}
        sprints={[sprint({ id: "b", name: "Sprint 13", state: "planned" }), sprint({ id: "a", name: "Sprint 12" })]}
        tickets={[boardTicket({ sprintId: "a" })]}
        tier="tickets"
        playbook={undefined}
        digest={[]}
        jiraBoardId={null}
        now={0}
        onOpenTicket={noop}
        onActivate={noop}
        onClose={noop}
        onDelete={noop}
        onSelectSprint={onSelectSprint}
      />,
    );
    cleanup = view.unmount;
    const pick = view.container.querySelector<HTMLSelectElement>(".sprint-pick")!;
    expect([...pick.options].map((option) => option.textContent)).toEqual(["Sprint 12 · active", "Sprint 13"]);
    act(() => {
      pick.value = "b";
      pick.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelectSprint).toHaveBeenCalledWith("b");
  });
});

describe("page navigation", () => {
  it("focusing a sprint on the Sprints page stays there; elsewhere it shows the board", () => {
    const store = createPmStore({ view: "sprints" });
    const controller = new PmController(fakeBridge(() => ok({})), store);
    controller.selectSprint("s2");
    expect(store.getState()).toMatchObject({ view: "sprints", selectedSprintId: "s2" });
    controller.setView("epics");
    controller.selectSprint("s3");
    expect(store.getState()).toMatchObject({ view: "overview", selectedSprintId: "s3" });
  });
});
