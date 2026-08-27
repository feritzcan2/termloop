// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/renderer/model.js";
import { SessionContextMenu } from "../src/renderer/ui/SessionRow.js";

const agent: Session = {
  id: "agent-1",
  project_id: "project-1",
  name: "Codex",
  kind: "Agent",
  lifecycle_state: "running",
  runtime_epoch: 1,
  archived_at_epoch_ms: null,
  resume_failure_reason: null,
  retryable: false,
  closable: true,
  forkable: true,
  ask_to_source_session_id: null,
  run_configuration_id: null,
  process: {
    program: "codex",
    args: [],
    cwd: "/repo",
    agent_id: "codex",
    template_ref: "builtin.agent.interactive",
    template_version: 1,
  },
};

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("Session context submenu", () => {
  it("keeps the Agents submenu open across its pointer gap, then closes over a sibling action", async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(SessionContextMenu, {
      state: { sessionId: agent.id, x: 10, y: 10, invoker: host },
      session: agent,
      visible: false,
      canSplit: true,
      closeMenu: vi.fn(),
      openHere: vi.fn(),
      openInSplit: vi.fn(),
      focus: vi.fn(),
      closePane: vi.fn(),
      rename: vi.fn(),
      forkSession: vi.fn(),
      agentActions: {
        askTargets: [{ agentId: "claude", label: "Claude" }],
        handoverTargets: [],
        askTo: vi.fn(),
        handoverTo: vi.fn(),
      },
      relocateSession: vi.fn(),
      copySessionId: vi.fn(),
      dismissSession: vi.fn(),
    })));

    const wrapper = host.querySelector<HTMLElement>(".context-menu-submenu")!;
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Agents"))!;
    const worktree = [...host.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Continue in Task worktree"))!;

    await act(async () => pointer(wrapper, "pointerover"));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      pointer(wrapper, "pointerout", worktree);
      vi.advanceTimersByTime(60);
      pointer(wrapper, "pointerover", worktree);
      vi.advanceTimersByTime(120);
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      pointer(wrapper, "pointerout", worktree);
      vi.advanceTimersByTime(120);
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => root.unmount());
  });
});

function pointer(target: Element, type: "pointerover" | "pointerout", relatedTarget: EventTarget | null = null): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget }));
}
