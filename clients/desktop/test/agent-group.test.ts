// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { presentationStore } from "../src/renderer/state/presentation-store.js";
import { AgentGroupFrame, agentSessionClusterMembers, agentSessionClusters } from "../src/renderer/ui/AgentGroup.js";

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

describe("Agent group controls", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("keeps every generation of forks beneath its exact source even when children arrive first", () => {
    const source = agent("source");
    const fork = { ...agent("fork"), fork_source_session_id: source.id };
    const nested = { ...agent("nested"), fork_source_session_id: fork.id };
    const sibling = { ...agent("sibling"), fork_source_session_id: source.id };
    const [cluster] = agentSessionClusters([nested, sibling, fork, source]);

    expect(cluster?.groups[0]?.helpers.map(({ session, source: parent, depth }) => [session.id, parent.id, depth]))
      .toEqual([["sibling", "source", 1], ["fork", "source", 1], ["nested", "fork", 2]]);
    expect(cluster && agentSessionClusterMembers(cluster).map((session) => session.id))
      .toEqual(["source", "sibling", "fork", "nested"]);
  });

  it("shows malformed cyclic forks once each", () => {
    const first = { ...agent("first"), fork_source_session_id: "second" };
    const second = { ...agent("second"), fork_source_session_id: "first" };
    const clusters = agentSessionClusters([first, second]);
    expect(clusters.flatMap((cluster) => agentSessionClusterMembers(cluster).map((session) => session.id)).sort())
      .toEqual(["first", "second"]);
  });

  it.each([
    ["ask_to_source_session_id", false], ["ask_to_source_session_id", true],
    ["fork_source_session_id", false], ["fork_source_session_id", true],
  ] as const)(
    "groups a %s helper without moving its source or losing its children (helper is target: %s)",
    (relationship, helperIsTarget) => {
      const source = agent("source");
      const helper = { ...agent("helper"), [relationship]: source.id };
      const child = { ...agent("child"), fork_source_session_id: helper.id };
      const peer = agent("peer");
      const sessions = [source, helper, child, peer];
      presentationStore.setState({
        sessionOrderByProject: { [source.project_id]: sessions.map((session) => session.id) },
        agentGroupsByProject: {},
        detachedAgentRelationshipsByProject: {},
      });
      expect(presentationStore.getState().groupAgentSessions(
        source.project_id, helperIsTarget ? peer.id : helper.id, helperIsTarget ? helper.id : peer.id,
      )).toBe(true);
      const clusters = () => agentSessionClusters(
        sessions,
        presentationStore.getState().agentGroupsByProject[source.project_id],
        new Set(presentationStore.getState().detachedAgentRelationshipsByProject[source.project_id]),
      );
      expect(clusters().map((cluster) => agentSessionClusterMembers(cluster).map((session) => session.id)))
        .toEqual([["source"], helperIsTarget ? ["helper", "child", "peer"] : ["peer", "helper", "child"]]);
      expect(clusters()[1]?.manuallyGrouped).toBe(true);
      expect(helper[relationship]).toBe(source.id);

      expect(presentationStore.getState().ungroupAgentGroup(source.project_id, helper.id)).toBe(true);
      expect(clusters().map((cluster) => agentSessionClusterMembers(cluster).map((session) => session.id)))
        .toEqual([["source"], ["helper", "child"], ["peer"]]);
      expect(helper[relationship]).toBe(source.id);
    },
  );

  it("renames a group inline and ungroups it from the leading close button", async () => {
    const first = agent("first-agent");
    const second = agent("second-agent");
    const [cluster] = agentSessionClusters(
      [first, second],
      [{ sessionIds: [first.id, second.id], name: "Review crew" }],
    );
    expect(cluster).toBeDefined();
    if (!cluster) throw new Error("manual Agent group did not form");

    const renamed: [string, string][] = [];
    const ungrouped: string[] = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    await act(async () => root!.render(createElement(AgentGroupFrame, {
      cluster,
      renameGroup: (sessionId: string, name: string) => { renamed.push([sessionId, name]); },
      ungroup: (sessionId: string) => { ungrouped.push(sessionId); },
      children: null,
    })));
    const label = container.querySelector<HTMLElement>(".manual-agent-group-label")!;
    expect(label.firstElementChild?.classList.contains("manual-agent-group-remove")).toBe(true);
    const renameButton = container.querySelector<HTMLButtonElement>(".manual-agent-group-name");
    expect(renameButton?.textContent).toBe("Review crew");
    expect(renameButton?.disabled).toBe(false);

    await act(async () => {
      renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>(".manual-agent-group-name-input");
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

    const removeButton = container.querySelector<HTMLButtonElement>(".manual-agent-group-remove");
    expect(removeButton?.disabled).toBe(false);
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(ungrouped).toEqual([first.id]);
  });
});
