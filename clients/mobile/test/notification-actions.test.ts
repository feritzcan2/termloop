import { describe, expect, it } from "vitest";

import type { TerminalAttachment, TerminalEvent } from "../src/application/ports";
import {
  agentActionAllowed,
  agentNotificationActionOf,
  performAgentNotificationAction,
} from "../src/features/notifications/notification-actions";
import { isAgentSessionVisible, markAgentSessionVisible } from "../src/features/notifications/visible-agent-session";

const data = { connectionId: "mac_1", sessionId: "ses_1", runtimeEpoch: 4, attentionKind: "needsInput", chatProjectId: null };
const running = [{ id: "ses_1", runtime_epoch: 4, lifecycle_state: "running" as const }];

describe("agent notification actions", () => {
  it("accepts only exact Agent targets and non-empty replies", () => {
    expect(agentNotificationActionOf("TERMLOOP_AGENT_APPROVE", undefined, data, undefined))
      .toEqual({ kind: "approve", sessionId: "ses_1", runtimeEpoch: 4 });
    expect(agentNotificationActionOf("TERMLOOP_AGENT_DENY", undefined, undefined, { payload: data }))
      .toEqual({ kind: "deny", sessionId: "ses_1", runtimeEpoch: 4 });
    expect(agentNotificationActionOf("TERMLOOP_REPLY", "  use main  ", data, undefined))
      .toEqual({ kind: "reply", sessionId: "ses_1", runtimeEpoch: 4, text: "use main" });
    expect(agentNotificationActionOf("TERMLOOP_REPLY", "   ", data, undefined)).toBeUndefined();
    expect(agentNotificationActionOf("expo.modules.notifications.actions.DEFAULT", undefined, data, undefined)).toBeUndefined();
    expect(agentNotificationActionOf("TERMLOOP_AGENT_APPROVE", undefined, { ...data, runtimeEpoch: null }, undefined)).toBeUndefined();
    expect(agentNotificationActionOf("TERMLOOP_REPLY", "hi", { ...data, chatProjectId: "prj_1" }, undefined)).toBeUndefined();
  });

  it("answers a permission prompt only while that exact epoch still waits", () => {
    const approve = { kind: "approve" as const, sessionId: "ses_1", runtimeEpoch: 4 };
    expect(agentActionAllowed(approve, running, [{ sessionId: "ses_1", status: "awaitingInput" }])).toBe(true);
    expect(agentActionAllowed(approve, running, [{ sessionId: "ses_1", status: "idle" }])).toBe(false);
    expect(agentActionAllowed({ ...approve, runtimeEpoch: 3 }, running, [{ sessionId: "ses_1", status: "awaitingInput" }])).toBe(false);
    const reply = { kind: "reply" as const, sessionId: "ses_1", runtimeEpoch: 4, text: "go" };
    expect(agentActionAllowed(reply, running, [{ sessionId: "ses_1", status: "idle" }])).toBe(true);
    expect(agentActionAllowed(reply, [{ ...running[0]!, lifecycle_state: "exited" as never }], [])).toBe(false);
  });

  it("sends one key after the terminal is ready and rechecks before writing", async () => {
    const writes: Uint8Array[] = [];
    let status = "awaitingInput";
    const runtime = fakeRuntime(writes, () => status);
    await expect(performAgentNotificationAction(runtime, "mac_1", { kind: "approve", sessionId: "ses_1", runtimeEpoch: 4 }))
      .resolves.toBe(true);
    expect(writes.map((bytes) => [...bytes])).toEqual([[13]]);

    writes.length = 0;
    status = "working";
    await expect(performAgentNotificationAction(runtime, "mac_1", { kind: "deny", sessionId: "ses_1", runtimeEpoch: 4 }))
      .resolves.toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("silences alerts only for the focused Agent screen", () => {
    const release = markAgentSessionVisible("ses_1");
    expect(isAgentSessionVisible("ses_1")).toBe(true);
    expect(isAgentSessionVisible("ses_2")).toBe(false);
    release();
    expect(isAgentSessionVisible("ses_1")).toBe(false);
  });
});

function fakeRuntime(writes: Uint8Array[], status: () => string) {
  return {
    control: {
      loadOverview: async () => ({
        sessions: running,
        agentStatuses: [{ sessionId: "ses_1", status: status() }],
      }),
    },
    terminal: {
      attach: async (_connectionId: string, _session: unknown, onEvent: (event: TerminalEvent) => void) => {
        setTimeout(() => onEvent({ type: "ready" } as TerminalEvent), 0);
        const attachment: TerminalAttachment = {
          input: async (bytes) => { writes.push(bytes); },
          reconnect: async () => {},
          detach: async () => {},
        };
        return attachment;
      },
    },
  } as never;
}
