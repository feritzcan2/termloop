import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectionConfig: vi.fn(),
  fork: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  MessageChannelMain: class {
    readonly port1 = {};
    readonly port2 = {};
  },
  utilityProcess: { fork: mocks.fork },
}));

import {
  TerminalGatewayRegistry,
  TerminalGatewaySupervisor,
} from "../src/main/terminal-gateway.js";

const localConfig = {
  kind: "local" as const,
  controlUrl: "ws://127.0.0.1:4000/control",
  token: "a".repeat(64),
  terminalUrl: "ws://127.0.0.1:4000/terminal",
  terminalToken: "b".repeat(64),
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("TerminalGatewaySupervisor", () => {
  it("kills and rejects a utility process whose launch is superseded by stop", async () => {
    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
    });
    mocks.fork.mockReturnValue(child);
    mocks.connectionConfig.mockResolvedValue(localConfig);
    const frame = { postMessage: vi.fn() };
    const supervisor = new TerminalGatewaySupervisor(
      "terminal-gateway.js",
      "local",
      mocks.connectionConfig,
    );

    const attaching = supervisor.attach(frame as never, "request-1", "session-1", 1);
    await Promise.resolve();
    supervisor.stop();
    child.emit("spawn");

    await expect(attaching).rejects.toThrow("superseded");
    expect(child.kill).toHaveBeenCalled();
    expect(frame.postMessage).not.toHaveBeenCalled();
  });

  it("isolates utility-process ownership per connection source", async () => {
    const children = [0, 1].map(() => Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
    }));
    mocks.fork.mockImplementation(() => {
      const child = children.shift();
      if (!child) throw new Error("unexpected gateway spawn");
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const spawned = [...children];
    const registry = new TerminalGatewayRegistry(
      "terminal-gateway.js",
      async () => localConfig,
    );
    const frame = { postMessage: vi.fn() };

    await Promise.all([
      registry.attach("local", frame as never, "request-local", "session-local", 1),
      registry.attach("123e4567-e89b-42d3-a456-426614174000", frame as never, "request-remote", "session-remote", 1),
    ]);
    registry.retain(new Set(["123e4567-e89b-42d3-a456-426614174000"]));

    expect(spawned[0]?.kill).toHaveBeenCalledOnce();
    expect(spawned[1]?.kill).not.toHaveBeenCalled();
    registry.stop();
    expect(spawned[1]?.kill).toHaveBeenCalledOnce();
  });

  it("keeps retrying when an SSH connection config is inside reconnect backoff", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
    });
    mocks.fork.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    mocks.connectionConfig
      .mockResolvedValueOnce(localConfig)
      .mockRejectedValueOnce(new Error("SSH tunnel is reconnecting"))
      .mockResolvedValueOnce(localConfig);
    const frame = { postMessage: vi.fn() };
    const supervisor = new TerminalGatewaySupervisor(
      "terminal-gateway.js",
      "local",
      mocks.connectionConfig,
    );

    await supervisor.attach(frame as never, "request-1", "session-1", 1);
    child.emit("message", { type: "state", state: "connectionLost" });
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(750);

    expect(mocks.connectionConfig).toHaveBeenCalledTimes(3);
    expect(child.postMessage.mock.calls.filter(([message]) => message.type === "configure"))
      .toHaveLength(2);
    supervisor.stop();
  });
});
