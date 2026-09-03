import type { SocketLike } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";

import {
  MobileControlClient,
  MobileControlError,
} from "../src/adapters/production/mobile-control-client";
import { createMobileDiagnosticReporter } from "../src/platform/mobile-diagnostics";

describe("mobile control failures", () => {
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
