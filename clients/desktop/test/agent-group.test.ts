// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { AgentGroupFrame, agentSessionClusters } from "../src/renderer/ui/AgentGroup.js";

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
