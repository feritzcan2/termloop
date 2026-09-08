import type { SocketLike } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import {
  MobileControlClient,
  MobileControlError,
} from "../src/adapters/production/mobile-control-client";
import { createMobileDiagnosticReporter } from "../src/platform/mobile-diagnostics";
import { startingWorkflowSteps, workflowDraft } from "../src/presentation/workflow-template";

describe("mobile control failures", () => {
  it.each(["task.previewWorkflow", "task.launchWorkflow", "agent.libraryGet", "workflow.configurationList", "workflow.configurationCreate", "workflow.configurationUpdate", "workflow.configurationDelete"] as const)("rejects malformed %s results using the generated contract", async (method) => {
    const socket = new RespondingSocket((request) => ({ id: request.id, ok: true, result: {} }));
    const client = new MobileControlClient("ws://127.0.0.1:48100/mobile", "test-token", () => {
      queueMicrotask(() => socket.emit("open", {})); return socket;
    });
    try { await expect(client.call(method)).rejects.toThrow(); } finally { client.close(); }
  });

  it("accepts generated workflow and profile projections", async () => {
    const configuration = { ...workflowDraft(), name: "Phone template", steps: startingWorkflowSteps("simple"), id: "11111111-2222-4333-8444-555555555555", projectId: "22222222-2222-4333-8444-555555555555", generation: 1, updatedAtEpochMs: 1 };
    const results = {
      "agent.libraryGet": { revision: 1, profiles: [] },
      "workflow.configurationList": { configurations: [configuration], executions: [], stateRevision: 1 },
      "workflow.configurationCreate": { configuration, stateRevision: 2 },
      "workflow.configurationUpdate": { configuration: { ...configuration, generation: 2 }, stateRevision: 3 },
      "workflow.configurationDelete": { workflowId: configuration.id, deleted: true, stateRevision: 4 },
    };
    for (const method of Object.keys(results) as Array<keyof typeof results>) {
      const socket = new RespondingSocket((request) => ({ id: request.id, ok: true, result: results[method] }));
      const client = new MobileControlClient("ws://127.0.0.1:48100/mobile", "test-token", () => { queueMicrotask(() => socket.emit("open", {})); return socket; });
      try { expect(await client.call(method)).toEqual(results[method]); } finally { client.close(); }
    }
  });

  it.each(["task.previewWorkflow", "task.launchWorkflow", "workflow.configurationCreate", "workflow.configurationUpdate", "workflow.configurationDelete"] as const)("never replays %s after transport loss", async (method) => {
    let sent = 0;
    let opened = 0;
    const socket = new RespondingSocket(() => { sent++; socket.emit("close", {}); return {}; });
    const client = new MobileControlClient("ws://127.0.0.1:48100/mobile", "test-token", () => { opened++; queueMicrotask(() => socket.emit("open", {})); return socket; });
    try {
      await expect(client.call(method)).rejects.toThrow();
      expect(sent).toBe(1); expect(opened).toBe(1);
    } finally { client.close(); }
  });

  it("keeps the daemon's structured reason for presentation and diagnostics", async () => {
    const lines: string[] = [];
    const socket = new RespondingSocket((request) => ({
      id: request.id,
      ok: false,
      error: {
        code: "conflict",
        message: "agent conversation fork is unavailable",
        details: { kind: "agentForkUnavailable", reason: "runtimeConflict" },
      },
    }));
    const client = new MobileControlClient(
      "ws://127.0.0.1:48100/mobile",
      "control-token",
      () => {
        queueMicrotask(() => socket.emit("open", {}));
        return socket;
      },
      createMobileDiagnosticReporter((line) => lines.push(line)),
      "macbook",
    );

    const failure = await client.call("session.forkAgent", { sessionId: "session-1" })
      .then(() => undefined, (cause: unknown) => cause);

    expect(failure).toBeInstanceOf(MobileControlError);
    expect(failure).toMatchObject({
      code: "conflict",
      details: { kind: "agentForkUnavailable", reason: "runtimeConflict" },
    });
    expect(lines.map(parseDiagnostic)).toContainEqual(expect.objectContaining({
      event: "request_completed",
      method: "session.forkAgent",
      errorCode: "conflict",
      reason: "runtimeConflict",
    }));
    client.close();
  });
});

type Listener = (event: unknown) => void;

class RespondingSocket implements SocketLike {
  private readonly listeners = new Map<string, Listener[]>();

  constructor(private readonly respond: (request: { id: string }) => unknown) {}

  addEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    const request = JSON.parse(data) as { id: string };
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(this.respond(request)) }));
  }

  close(): void {}

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function parseDiagnostic(line: string): Record<string, unknown> {
  return JSON.parse(line.replace("[termloop-mobile] ", "")) as Record<string, unknown>;
}
