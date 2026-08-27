import { describe, expect, it } from "vitest";
import {
  MAX_LAYOUT_PANES,
  activePane,
  assignSession,
  closePane,
  createProjectLayout,
  decodeLayoutDocument,
  focusRelativePane,
  paneForSession,
  panes,
  resizeSplit,
  splitPane,
} from "../src/layout/model.js";

function ids(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

describe("client-local layout model", () => {
  it("splits deterministically, keeps Session references unique, and cycles focus in render order", () => {
    const createId = ids();
    const initial = createProjectLayout("session-a", createId);
    const split = splitPane(initial, initial.activePaneId, "horizontal", createId);
    expect(split).toBeDefined();
    if (!split) return;
    const assigned = assignSession(split, split.activePaneId, "session-b");
    expect(panes(assigned).map((pane) => pane.sessionId)).toEqual(["session-a", "session-b"]);
    expect(activePane(focusRelativePane(assigned, -1)).sessionId).toBe("session-a");

    const moved = assignSession(assigned, panes(assigned)[0]!.id, "session-b");
    expect(panes(moved).map((pane) => pane.sessionId)).toEqual(["session-b", null]);
    expect(paneForSession(moved, "session-b")?.id).toBe(panes(moved)[0]!.id);
  });

  it("closes by collapsing the tree, clamps resize, and enforces the pane cap", () => {
    const createId = ids();
    let layout = createProjectLayout("session-a", createId);
    for (let index = 1; index < MAX_LAYOUT_PANES; index += 1) {
      const next = splitPane(layout, layout.activePaneId, index % 2 ? "horizontal" : "vertical", createId);
      expect(next).toBeDefined();
      layout = next!;
    }
    expect(splitPane(layout, layout.activePaneId, "horizontal", createId)).toBeUndefined();
    const splitId = layout.root.type === "split" ? layout.root.id : "missing";
    expect(resizeSplit(layout, splitId, 0.99).root).toMatchObject({ ratio: 0.85 });
    expect(panes(closePane(layout, layout.activePaneId))).toHaveLength(MAX_LAYOUT_PANES - 1);
  });

  it("rejects malformed, duplicate, and unbounded durable layouts", () => {
    const duplicate = {
      version: 2,
      profiles: {
        local: { projects: { project: {
          activePaneId: "pane-a",
          root: {
            type: "split", id: "split", direction: "horizontal", ratio: 0.5,
            first: { type: "pane", id: "pane-a", sessionId: "session" },
            second: { type: "pane", id: "pane-b", sessionId: "session" },
          },
        } }, sessionOrderByProject: {} },
      },
    };
    expect(decodeLayoutDocument(duplicate)).toBeUndefined();
    expect(decodeLayoutDocument({ version: 2, projects: {} })).toBeUndefined();
    expect(decodeLayoutDocument({ version: 2, profiles: {} })).toEqual({ version: 2, profiles: {} });
    expect(decodeLayoutDocument({ version: 2, profiles: { local: { projects: {}, sessionOrderByProject: { project: ["one", "one"] } } } })).toBeUndefined();
    expect(decodeLayoutDocument({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        detachedAgentRelationshipsByProject: { project: ["helper-one", "helper-two"] },
      } },
    })?.profiles.local?.detachedAgentRelationshipsByProject?.project).toEqual(["helper-one", "helper-two"]);
    expect(decodeLayoutDocument({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        detachedAgentRelationshipsByProject: { project: ["helper", "helper"] },
      } },
    })).toBeUndefined();
    expect(decodeLayoutDocument({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        agentGroupsByProject: { project: [["one", "two"]] },
      } },
    })).toEqual({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        agentGroupsByProject: { project: [{ sessionIds: ["one", "two"] }] },
      } },
    });
    expect(decodeLayoutDocument({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        agentGroupsByProject: { project: [{ sessionIds: ["one", "two"], name: "  Review crew  " }] },
      } },
    })?.profiles.local?.agentGroupsByProject?.project).toEqual([
      { sessionIds: ["one", "two"], name: "Review crew" },
    ]);
    expect(decodeLayoutDocument({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        agentGroupsByProject: { project: [["one"], ["one", "two"]] },
      } },
    })).toBeUndefined();
    expect(decodeLayoutDocument({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        agentGroupsByProject: { project: [{ sessionIds: ["one", "two"], name: " " }] },
      } },
    })).toBeUndefined();
    expect(decodeLayoutDocument({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        agentGroupsByProject: { project: [["one", "one"]] },
      } },
    })).toBeUndefined();
    expect(decodeLayoutDocument({
      version: 2,
      profiles: { local: {
        projects: {},
        sessionOrderByProject: {},
        agentGroupsByProject: { project: [["one", "two"], ["two", "three"]] },
      } },
    })).toBeUndefined();
  });
});
