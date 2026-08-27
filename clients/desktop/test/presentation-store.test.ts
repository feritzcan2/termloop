import { beforeEach, describe, expect, it } from "vitest";
import { panes } from "../src/layout/model.js";
import { connectionEntityKey } from "../src/connection-scope.js";
import { presentationStore } from "../src/renderer/state/presentation-store.js";

describe("presentation store", () => {
  beforeEach(() => {
    presentationStore.setState({
      selectedProjectId: undefined,
      selectedSessionByProject: {},
      sessionOrderByProject: {},
      agentGroupsByProject: {},
      detachedAgentRelationshipsByProject: {},
      reviewReadySessionIds: new Set(),
      interruptedSessionObservations: new Map(),
      acknowledgedInterruptedSessionObservations: new Map(),
      layoutsByProject: {},
      layoutLoaded: false,
      layoutRevision: 0,
      projectDialogOpen: false,
    });
  });

  it("keeps a completed agent highlighted until its Session is selected", () => {
    presentationStore.getState().updateReviewReadySessions(["session-a"], ["session-a"]);
    expect(presentationStore.getState().reviewReadySessionIds).toEqual(new Set(["session-a"]));

    presentationStore.getState().selectSession("project-a", "session-a");
    expect(presentationStore.getState().reviewReadySessionIds).toEqual(new Set());
  });

  it("acknowledges the exact interrupted observation after navigating away", () => {
    const interrupted = {
      sessionId: "session-a",
      status: "interrupted" as const,
      source: "appServer" as const,
      observedAtEpochMs: 10,
    };
    presentationStore.getState().updateInterruptedSessions([interrupted]);
    presentationStore.getState().selectSession("project-a", "session-a");
    expect(presentationStore.getState().acknowledgedInterruptedSessionObservations).toEqual(new Map());

    presentationStore.getState().selectSession("project-a", "session-b");
    expect(presentationStore.getState().acknowledgedInterruptedSessionObservations).toEqual(
      new Map([["session-a", 10]]),
    );

    presentationStore.getState().updateInterruptedSessions([{ ...interrupted, observedAtEpochMs: 11 }]);
    expect(presentationStore.getState().acknowledgedInterruptedSessionObservations).toEqual(new Map());
  });

  it("keeps one Session selection per Project without storing daemon state", () => {
    const sessions = new Map<string, readonly string[]>([
      ["project-a", ["session-a1", "session-a2"]],
      ["project-b", ["session-b1"]],
    ]);
    presentationStore.getState().ensureSelection(["project-a", "project-b"], sessions);
    presentationStore.getState().selectSession("project-a", "session-a2");
    presentationStore.getState().selectProject("project-b");
    presentationStore.getState().selectProject("project-a");

    const state = presentationStore.getState();
    expect(state.selectedProjectId).toBe("project-a");
    expect(state.selectedSessionByProject).toEqual({
      "project-a": "session-a2",
      "project-b": "session-b1",
    });
    expect(state).not.toHaveProperty("runtimeEpoch");
    expect(state).not.toHaveProperty("cwd");
    expect(state).not.toHaveProperty("tasks");
  });

  it("keeps explicit detach through projection refresh without terminating or reselecting", () => {
    const sessions = new Map<string, readonly string[]>([["project-a", ["session-a1", "session-a2"]]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);
    const layout = presentationStore.getState().layoutsByProject["project-a"];
    expect(layout).toBeDefined();
    presentationStore.getState().closePane("project-a", layout?.activePaneId ?? "missing");
    presentationStore.getState().ensureSelection(["project-a"], sessions);

    expect(presentationStore.getState().selectedSessionByProject["project-a"]).toBeNull();
    expect(presentationStore.getState().sessionOrderByProject["project-a"]).toEqual(["session-a1", "session-a2"]);
  });

  it("keeps manual list order stable across pointer and keyboard selection", () => {
    const sessions = new Map<string, readonly string[]>([["project-a", ["session-a1", "session-a2", "session-a3"]]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);
    presentationStore.getState().selectSession("project-a", "session-a3");
    presentationStore.getState().navigateSession("project-a", "session-a2");

    const state = presentationStore.getState();
    expect(state.selectedSessionByProject["project-a"]).toBe("session-a2");
    expect(state.sessionOrderByProject["project-a"]).toEqual(["session-a1", "session-a2", "session-a3"]);
  });

  it("persists split presentation while keeping missing Session references explicit", () => {
    const sessions = new Map<string, readonly string[]>([["project-a", ["session-a1", "session-a2"]]]);
    presentationStore.getState().hydrateLayouts({ version: 2, profiles: {} });
    presentationStore.getState().ensureSelection(["project-a"], sessions);
    expect(presentationStore.getState().openSessionInSplit("project-a", "session-a2", "horizontal")).toBe(true);

    const document = presentationStore.getState().layoutDocument();
    expect(document.profiles.local?.projects["project-a"]).toBeDefined();
    presentationStore.getState().ensureSelection(["project-a"], new Map([["project-a", ["session-a1"]]]));
    expect(presentationStore.getState().selectedSessionByProject["project-a"]).toBeNull();
    expect(presentationStore.getState().layoutDocument().profiles.local?.projects)
      .toEqual(document.profiles.local?.projects);
    expect(presentationStore.getState().sessionOrderByProject["project-a"]).toEqual(["session-a1"]);
  });

  it("opens an invisible Session in a new split without duplicating visible Sessions", () => {
    const sessions = new Map<string, readonly string[]>([["project-a", ["session-a1", "session-a2"]]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);

    expect(presentationStore.getState().openSessionInSplit("project-a", "session-a2", "horizontal")).toBe(true);
    const splitLayout = presentationStore.getState().layoutsByProject["project-a"];
    expect(splitLayout && splitLayout.root.type).toBe("split");
    expect(splitLayout && panes(splitLayout).map((pane) => pane.sessionId)).toEqual(["session-a1", "session-a2"]);
    expect(presentationStore.getState().selectedSessionByProject["project-a"]).toBe("session-a2");

    expect(presentationStore.getState().openSessionInSplit("project-a", "session-a1", "vertical")).toBe(true);
    const afterVisibleFocus = presentationStore.getState().layoutsByProject["project-a"];
    expect(afterVisibleFocus && afterVisibleFocus.root.type).toBe("split");
    expect(afterVisibleFocus && panes(afterVisibleFocus)).toHaveLength(2);
    expect(afterVisibleFocus && afterVisibleFocus.activePaneId).toBe(splitLayout && panes(splitLayout)[0]?.id);
  });

  it("opens a dragged Session beside the pane it was dropped on", () => {
    const sessions = new Map<string, readonly string[]>([["project-a", ["session-a1", "session-a2", "session-a3"]]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);
    const firstLayout = presentationStore.getState().layoutsByProject["project-a"]!;
    expect(presentationStore.getState().openSessionInSplitAtPane("project-a", firstLayout.activePaneId, "session-a2", "horizontal")).toBe(true);

    const splitLayout = presentationStore.getState().layoutsByProject["project-a"]!;
    const firstPane = panes(splitLayout)[0]!;
    expect(presentationStore.getState().openSessionInSplitAtPane("project-a", firstPane.id, "session-a3", "vertical", "before")).toBe(true);

    const finalLayout = presentationStore.getState().layoutsByProject["project-a"]!;
    expect(finalLayout.root.type).toBe("split");
    expect(finalLayout.root.type === "split" ? finalLayout.root.direction : undefined).toBe("horizontal");
    expect(finalLayout.root.type === "split" && finalLayout.root.first.type === "split" ? finalLayout.root.first.direction : undefined).toBe("vertical");
    expect(panes(finalLayout).map((pane) => pane.sessionId)).toEqual(["session-a3", "session-a1", "session-a2"]);
  });

  it("creates an empty active split without terminating or duplicating a Session", () => {
    const sessions = new Map<string, readonly string[]>([["project-a", ["session-a1"]]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);

    expect(presentationStore.getState().splitActivePane("project-a", "horizontal")).toBe(true);
    const state = presentationStore.getState();
    const layout = state.layoutsByProject["project-a"];
    expect(layout && panes(layout).map((pane) => pane.sessionId)).toEqual(["session-a1", null]);
    expect(state.selectedSessionByProject["project-a"]).toBeNull();
    expect(state.sessionOrderByProject["project-a"]).toEqual(["session-a1"]);
  });

  it("persists explicit Session reorder without changing selection", () => {
    const sessions = new Map<string, readonly string[]>([["project-a", ["session-a1", "session-a2", "session-a3"]]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);
    expect(presentationStore.getState().reorderSession("project-a", "session-a3", "session-a1", "before")).toBe(true);

    const state = presentationStore.getState();
    expect(state.sessionOrderByProject["project-a"]).toEqual(["session-a3", "session-a1", "session-a2"]);
    expect(state.selectedSessionByProject["project-a"]).toBe("session-a1");
    expect(state.layoutDocument().profiles.local?.sessionOrderByProject["project-a"])
      .toEqual(["session-a3", "session-a1", "session-a2"]);
  });

  it("groups Agents on top of their target and persists the peer group", () => {
    const sessions = new Map<string, readonly string[]>([[
      "project-a",
      ["session-a1", "session-a2", "session-a3", "session-a4"],
    ]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);

    expect(presentationStore.getState().groupAgentSessions("project-a", "session-a3", "session-a2")).toBe(true);
    expect(presentationStore.getState().groupAgentSessions("project-a", "session-a4", "session-a2")).toBe(true);

    const state = presentationStore.getState();
    expect(state.agentGroupsByProject["project-a"]).toEqual([{
      sessionIds: ["session-a2", "session-a4", "session-a3"],
    }]);
    expect(state.sessionOrderByProject["project-a"]).toEqual([
      "session-a1", "session-a2", "session-a4", "session-a3",
    ]);
    expect(state.layoutDocument().profiles.local?.agentGroupsByProject?.["project-a"])
      .toEqual([{ sessionIds: ["session-a2", "session-a4", "session-a3"] }]);
  });

  it("moves the dragged Agent to the target when grouping downward", () => {
    const sessions = new Map<string, readonly string[]>([[
      "project-a",
      ["session-a1", "session-a2", "session-a3"],
    ]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);

    expect(presentationStore.getState().groupAgentSessions("project-a", "session-a1", "session-a3")).toBe(true);
    expect(presentationStore.getState().agentGroupsByProject["project-a"])
      .toEqual([{ sessionIds: ["session-a3", "session-a1"] }]);
    expect(presentationStore.getState().sessionOrderByProject["project-a"])
      .toEqual(["session-a2", "session-a3", "session-a1"]);
  });

  it("persists a group name across hydration and can ungroup without closing Agents", () => {
    const sessions = new Map<string, readonly string[]>([[
      "project-a",
      ["session-a1", "session-a2"],
    ]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);
    presentationStore.getState().groupAgentSessions("project-a", "session-a2", "session-a1");

    expect(presentationStore.getState().renameAgentGroup("project-a", "session-a1", "  Review crew  ")).toBe(true);
    const saved = presentationStore.getState().layoutDocument();
    expect(saved.profiles.local?.agentGroupsByProject?.["project-a"])
      .toEqual([{ sessionIds: ["session-a1", "session-a2"], name: "Review crew" }]);

    presentationStore.setState({ agentGroupsByProject: {}, layoutsByProject: {}, sessionOrderByProject: {} });
    presentationStore.getState().hydrateLayouts(saved);
    const hydratedProjectId = connectionEntityKey("local", "project-a");
    const hydratedFirstId = connectionEntityKey("local", "session-a1");
    const hydratedSecondId = connectionEntityKey("local", "session-a2");
    expect(presentationStore.getState().agentGroupsByProject[hydratedProjectId])
      .toEqual([{ sessionIds: [hydratedFirstId, hydratedSecondId], name: "Review crew" }]);
    expect(presentationStore.getState().ungroupAgentGroup(hydratedProjectId, hydratedSecondId)).toBe(true);
    expect(presentationStore.getState().agentGroupsByProject).not.toHaveProperty(hydratedProjectId);
    expect(presentationStore.getState().sessionOrderByProject[hydratedProjectId])
      .toEqual([hydratedFirstId, hydratedSecondId]);
  });

  it("persists a detached projected relationship and prunes it with the Session", () => {
    presentationStore.getState().ensureSelection(
      ["project-a"],
      new Map([["project-a", ["source", "helper"]]]),
    );

    expect(presentationStore.getState().detachAgentRelationship("project-a", "helper")).toBe(true);
    expect(presentationStore.getState().detachAgentRelationship("project-a", "helper")).toBe(false);
    const saved = presentationStore.getState().layoutDocument();
    expect(saved.profiles.local?.detachedAgentRelationshipsByProject?.["project-a"])
      .toEqual(["helper"]);

    presentationStore.getState().hydrateLayouts(saved);
    const scopedProjectId = connectionEntityKey("local", "project-a");
    const scopedHelperId = connectionEntityKey("local", "helper");
    expect(presentationStore.getState().detachedAgentRelationshipsByProject[scopedProjectId])
      .toEqual([scopedHelperId]);

    presentationStore.getState().ensureSelection(
      [scopedProjectId],
      new Map([[scopedProjectId, [connectionEntityKey("local", "source")]]]),
    );
    expect(presentationStore.getState().detachedAgentRelationshipsByProject)
      .not.toHaveProperty(scopedProjectId);
  });

  it("uses edge drops to detach a row from its group", () => {
    const sessions = new Map<string, readonly string[]>([[
      "project-a",
      ["session-a1", "session-a2", "session-a3"],
    ]]);
    presentationStore.getState().ensureSelection(["project-a"], sessions);
    presentationStore.getState().groupAgentSessions("project-a", "session-a3", "session-a2");

    expect(presentationStore.getState().reorderSession("project-a", "session-a3", "session-a2", "before")).toBe(true);
    expect(presentationStore.getState().agentGroupsByProject).not.toHaveProperty("project-a");
    expect(presentationStore.getState().sessionOrderByProject["project-a"])
      .toEqual(["session-a1", "session-a3", "session-a2"]);
  });

  it("dissolves a group when projection refresh leaves fewer than two Sessions", () => {
    presentationStore.getState().ensureSelection(
      ["project-a"],
      new Map([["project-a", ["session-a1", "session-a2"]]]),
    );
    presentationStore.getState().groupAgentSessions("project-a", "session-a2", "session-a1");

    presentationStore.getState().ensureSelection(
      ["project-a"],
      new Map([["project-a", ["session-a1"]]]),
    );

    expect(presentationStore.getState().agentGroupsByProject).not.toHaveProperty("project-a");
  });

  it("prunes deleted Project presentation state and selects the next Project", () => {
    const sessions = new Map<string, readonly string[]>([
      ["project-a", ["session-a1"]],
      ["project-b", ["session-b1"]],
    ]);
    presentationStore.getState().hydrateLayouts({ version: 2, profiles: {} });
    presentationStore.getState().ensureSelection(["project-a", "project-b"], sessions);
    presentationStore.getState().selectProject("project-a");
    const revision = presentationStore.getState().layoutRevision;

    presentationStore.getState().ensureSelection(
      ["project-b"],
      new Map([["project-b", ["session-b1"]]]),
    );

    const state = presentationStore.getState();
    expect(state.selectedProjectId).toBe("project-b");
    expect(state.selectedSessionByProject).not.toHaveProperty("project-a");
    expect(state.sessionOrderByProject).not.toHaveProperty("project-a");
    expect(state.layoutsByProject).not.toHaveProperty("project-a");
    expect(state.layoutDocument().profiles.local?.projects ?? {}).not.toHaveProperty("project-a");
    expect(state.layoutRevision).toBeGreaterThan(revision);
  });

  it("retains layout state while a remote source is disabled", () => {
    const profileId = "123e4567-e89b-42d3-a456-426614174000";
    const projectId = connectionEntityKey(profileId, "project-a");
    const sessionId = connectionEntityKey(profileId, "session-a");
    const peerSessionId = connectionEntityKey(profileId, "session-b");
    presentationStore.getState().ensureSelection(
      [projectId],
      new Map([[projectId, [sessionId, peerSessionId]]]),
    );
    presentationStore.getState().groupAgentSessions(projectId, peerSessionId, sessionId);

    presentationStore.getState().ensureSelection([], new Map(), new Set([profileId]));

    expect(presentationStore.getState().layoutsByProject[projectId]).toBeDefined();
    expect(presentationStore.getState().layoutDocument().profiles[profileId]?.projects["project-a"])
      .toBeDefined();
    expect(presentationStore.getState().layoutDocument().profiles[profileId]?.agentGroupsByProject?.["project-a"])
      .toEqual([{ sessionIds: ["session-a", "session-b"] }]);
  });
});
