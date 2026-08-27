// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus, Session } from "../src/renderer/model.js";
import { ActiveAgentRail, type ActiveAgentRailProps } from "../src/renderer/ui/ActiveAgentRail.js";
import { SidebarSessionDndProvider } from "../src/renderer/ui/SidebarSessionDnd.js";

function agent(id: string): Session {
  return {
    id,
    project_id: "project-1",
    name: id,
    kind: "Agent",
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
  ask_to_source_session_id: null,
  run_configuration_id: null,
    process: {
      program: "/usr/local/bin/codex",
      args: [],
      cwd: `/repo/${id}`,
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: null,
    },
  } as Session;
}

function status(sessionId: string, value: AgentStatus["status"]): AgentStatus {
  return { sessionId, status: value, source: "appServer", observedAtEpochMs: 1 };
}

function props(
  sessions: readonly Session[],
  statuses: readonly AgentStatus[],
  selectedSession?: Session,
): ActiveAgentRailProps {
  return {
    sessions,
    projectFolder: "/repo/termloop-next",
    selectedSession,
    visibleSessionIds: new Set(),
    statusesById: new Map(statuses.map((value) => [value.sessionId, value])),
    reviewReadySessionIds: new Set(),
    favoriteSessionIds: new Set(),
    taskAttachedSessionIds: new Set(),
    worktreeChangesBySessionId: new Map(),
    menuSessionId: undefined,
    selectSession: () => {},
    navigateSession: () => {},
    openSessionMenu: () => {},
    dismissSession: () => {},
    resumeSession: () => {},
    archiveSession: () => {},
    toggleFavoriteSession: () => {},
    openTaskChanges: () => {},
    searchOpen: false,
    setSearchOpen: () => {},
    nowEpochMs: 100,
  };
}

function sectionFor(container: HTMLElement, sessionId: string): string | null {
  return container.querySelector(`[data-session-id="${sessionId}"]`)
    ?.closest<HTMLElement>("[data-active-agent-section]")
    ?.dataset.activeAgentSection ?? null;
}

function pointerEvent(type: "pointerdown" | "pointermove" | "pointerup", clientX: number, clientY = 10): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
  });
  return event;
}

describe("Active Agent selection stability", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;
  let restoreBoundingRect: (() => void) | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    restoreBoundingRect?.();
    root = undefined;
    container = undefined;
    restoreBoundingRect = undefined;
  });

  it.each([
    ["awaitingInput", "Action needed"],
    ["interrupted", "Interrupted"],
  ] as const)("moves a selected %s agent to its truthful current section", async (initialStatus, initialSection) => {
    const selected = agent("selected");
    const other = agent("other");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => root!.render(createElement(
      ActiveAgentRail,
      props([selected, other], [status(selected.id, initialStatus), status(other.id, "idle")]),
    )));
    expect(sectionFor(container, selected.id)).toBe(initialSection);

    await act(async () => root!.render(createElement(
      ActiveAgentRail,
      props([selected, other], [status(selected.id, initialStatus), status(other.id, "idle")], selected),
    )));
    expect(sectionFor(container, selected.id)).toBe(initialSection);

    // The rail must not retain a stale section label while the row itself has
    // already changed to Working.
    await act(async () => root!.render(createElement(
      ActiveAgentRail,
      props([selected, other], [status(selected.id, "working"), status(other.id, "idle")], selected),
    )));
    expect(sectionFor(container, selected.id)).toBe("In progress");

    await act(async () => root!.render(createElement(
      ActiveAgentRail,
      props([selected, other], [status(selected.id, "working"), status(other.id, "idle")], other),
    )));
    expect(sectionFor(container, selected.id)).toBe("In progress");
  });

  it.each([
    ["idle", "working", "Idle / paused", "In progress"],
    ["interrupted", "idle", "Interrupted", "Idle / paused"],
  ] as const)("moves a selected agent on %s to %s", async (initialStatus, nextStatus, initialSection, nextSection) => {
    const selected = agent("selected");
    const other = agent("other");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => root!.render(createElement(
      ActiveAgentRail,
      props([selected, other], [status(selected.id, initialStatus), status(other.id, "working")], selected),
    )));
    expect(sectionFor(container, selected.id)).toBe(initialSection);

    await act(async () => root!.render(createElement(
      ActiveAgentRail,
      props([selected, other], [status(selected.id, nextStatus), status(other.id, "working")], selected),
    )));
    expect(sectionFor(container, selected.id)).toBe(nextSection);
  });

  it("keeps a selected working agent in progress when favorite state changes", async () => {
    const selected = agent("selected");
    const other = agent("other");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const railProps = props(
      [other, selected],
      [status(other.id, "working"), status(selected.id, "working")],
      selected,
    );

    await act(async () => root!.render(createElement(ActiveAgentRail, railProps)));
    expect(sectionFor(container, selected.id)).toBe("In progress");
    expect(container.querySelector("[data-active-agent-section=\"In progress\"] [data-session-id]")?.getAttribute("data-session-id")).toBe(other.id);

    await act(async () => root!.render(createElement(
      ActiveAgentRail,
      { ...railProps, favoriteSessionIds: new Set([selected.id]) },
    )));
    expect(sectionFor(container, selected.id)).toBe("In progress");
    expect(container.querySelector("[data-active-agent-section=\"In progress\"] [data-session-id]")?.getAttribute("data-session-id")).toBe(selected.id);

    await act(async () => root!.render(createElement(ActiveAgentRail, railProps)));
    expect(sectionFor(container, selected.id)).toBe("In progress");
    expect(container.querySelector("[data-active-agent-section=\"In progress\"] [data-session-id]")?.getAttribute("data-session-id")).toBe(other.id);
  });

  it("shows shared drag feedback when an Agent row is dragged from the Agents view", async () => {
    const dragged = agent("dragged-agent");
    const dragStates: boolean[] = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLElement.prototype.scrollIntoView = () => {};

    await act(async () => root!.render(createElement(
      SidebarSessionDndProvider,
      {
        sessions: [dragged],
        reorderSession: () => false,
        draggingChanged: (dragging) => dragStates.push(dragging),
        children: createElement(ActiveAgentRail, props([dragged], [status(dragged.id, "working")])),
      },
    )));

    const row = container.querySelector<HTMLElement>(`[data-session-id="${dragged.id}"]`);
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(pointerEvent("pointerdown", 10));
      document.dispatchEvent(pointerEvent("pointermove", 15));
    });

    expect(dragStates).toContain(true);
    expect(document.querySelector(".session-drag-preview")?.textContent).toContain("dragged-agent");

    await act(async () => { document.dispatchEvent(pointerEvent("pointerup", 15)); });
  });

  it("groups Agents when one row is dropped on the middle of another", async () => {
    const source = agent("source-agent");
    const target = agent("target-agent");
    const grouped: [string, string][] = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLElement.prototype.scrollIntoView = () => {};
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const sessionId = this.getAttribute("data-session-drop-target");
      if (sessionId === source.id) return domRect(0, 40);
      if (sessionId === target.id) return domRect(50, 40);
      return originalBoundingRect.call(this);
    };
    restoreBoundingRect = () => { HTMLElement.prototype.getBoundingClientRect = originalBoundingRect; };

    await act(async () => root!.render(createElement(
      SidebarSessionDndProvider,
      {
        sessions: [source, target],
        reorderSession: () => false,
        groupAgentSessions: (sessionId: string, targetSessionId: string) => {
          grouped.push([sessionId, targetSessionId]);
          return true;
        },
        children: createElement(ActiveAgentRail, props(
          [source, target],
          [status(source.id, "working"), status(target.id, "working")],
        )),
      },
    )));

    const sourceButton = container.querySelector<HTMLElement>(`[data-session-id="${source.id}"]`)!;
    const targetTarget = container.querySelector<HTMLElement>(`[data-session-drop-target="${target.id}"]`)!;

    await act(async () => {
      sourceButton.dispatchEvent(pointerEvent("pointerdown", 10, 10));
      document.dispatchEvent(pointerEvent("pointermove", 10, 16));
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      document.dispatchEvent(pointerEvent("pointermove", 10, 80));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.querySelector(".session-drag-preview")).not.toBeNull();
    expect([...container.querySelectorAll<HTMLElement>(".drop-on, .drop-before, .drop-after")].map((node) => ({
      className: node.className,
      sessionId: node.closest<HTMLElement>("[data-session-drop-target]")?.dataset.sessionDropTarget,
    }))).toEqual([{ className: "session-row active-agent-row drop-on", sessionId: target.id }]);
    await act(async () => { document.dispatchEvent(pointerEvent("pointerup", 10, 80)); });

    expect(grouped).toEqual([[source.id, target.id]]);
  });

  it("adds another Agent by dropping it on an existing group", async () => {
    const first = agent("first-agent");
    const second = agent("second-agent");
    const third = agent("third-agent");
    const grouped: [string, string][] = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLElement.prototype.scrollIntoView = () => {};
    const originalBoundingRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.getAttribute("data-session-drop-target") === third.id) return domRect(80, 40);
      if (this.getAttribute("data-agent-group-drop-target") === first.id) return domRect(20, 20);
      return originalBoundingRect.call(this);
    };
    restoreBoundingRect = () => { HTMLElement.prototype.getBoundingClientRect = originalBoundingRect; };
    const railProps = props(
      [first, second, third],
      [status(first.id, "working"), status(second.id, "working"), status(third.id, "working")],
    );
    railProps.agentGroups = [{ sessionIds: [first.id, second.id] }];

    await act(async () => root!.render(createElement(
      SidebarSessionDndProvider,
      {
        sessions: [first, second, third],
        reorderSession: () => false,
        groupAgentSessions: (sessionId: string, targetSessionId: string) => {
          grouped.push([sessionId, targetSessionId]);
          return true;
        },
        children: createElement(ActiveAgentRail, railProps),
      },
    )));

    const thirdButton = container.querySelector<HTMLElement>(`[data-session-id="${third.id}"]`)!;
    await act(async () => {
      thirdButton.dispatchEvent(pointerEvent("pointerdown", 10, 90));
      document.dispatchEvent(pointerEvent("pointermove", 10, 96));
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      document.dispatchEvent(pointerEvent("pointermove", 10, 30));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(container.querySelector(".manual-agent-group.drop-on")).not.toBeNull();
    await act(async () => { document.dispatchEvent(pointerEvent("pointerup", 10, 30)); });

    expect(grouped).toEqual([[third.id, first.id]]);
  });

  it("renames a group inline and ungroups it from the leading close button", async () => {
    const first = agent("first-agent");
    const second = agent("second-agent");
    const renamed: [string, string][] = [];
    const ungrouped: string[] = [];
    container = document.createElement("div");
    document.body.append(container);
    const rendered = container;
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const railProps = props(
      [first, second],
      [status(first.id, "working"), status(second.id, "working")],
    );
    railProps.agentGroups = [{ sessionIds: [first.id, second.id], name: "Review crew" }];
    railProps.renameAgentGroup = (sessionId, name) => { renamed.push([sessionId, name]); };
    railProps.ungroupAgentGroup = (sessionId) => { ungrouped.push(sessionId); };

    await act(async () => root!.render(createElement(ActiveAgentRail, railProps)));
    const label = rendered.querySelector<HTMLElement>(".manual-agent-group-label")!;
    expect(label.firstElementChild?.classList.contains("manual-agent-group-remove")).toBe(true);
    expect(rendered.querySelector(".manual-agent-group-name")?.textContent).toBe("Review crew");

    await act(async () => {
      rendered.querySelector<HTMLButtonElement>(".manual-agent-group-name")!.click();
    });
    await vi.waitFor(() => {
      expect(rendered.querySelector(".manual-agent-group-name-input")).not.toBeNull();
    }, { timeout: 2_000, interval: 10 });
    const input = rendered.querySelector<HTMLInputElement>(".manual-agent-group-name-input");
    expect(input).not.toBeNull();
    if (!input) throw new Error("group rename input did not render");
    const inputWindow = input.ownerDocument.defaultView!;
    const valueSetter = Object.getOwnPropertyDescriptor(inputWindow.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      valueSetter?.call(input, "Release team");
      input.dispatchEvent(new inputWindow.Event("input", { bubbles: true }));
      input.dispatchEvent(new inputWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(renamed).toEqual([[first.id, "Release team"]]);

    await act(async () => {
      rendered.querySelector<HTMLButtonElement>(".manual-agent-group-remove")!.click();
    });
    expect(ungrouped).toEqual([first.id]);
  });
});

function domRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 200,
    bottom: top + height,
    left: 0,
    width: 200,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}
