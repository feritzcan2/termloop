import { afterEach, describe, expect, it, vi } from "vitest";
import { TermLoopControlClient, controlRequestTimeoutMs } from "@termloop/contract/current";

vi.mock("electron", () => ({
  app: { getPath: () => "." },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { ConnectionRegistry } from "../src/main/connection-registry.js";
import type { DesktopConnectionConfig } from "../src/main/connection-profiles.js";

const PROFILE = "123e4567-e89b-42d3-a456-426614174000";
const accounts = { accounts: [
  { accountId: "default", agentId: "codex", name: "Default account", isDefault: true },
  { accountId: "default", agentId: "claude", name: "Default account", isDefault: true },
], revision: 1 };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const profiles = {
    list: async () => [{ id: PROFILE, name: "Remote", transport: "tailscale", scope: "full", endpoint: "remote", enabled: true, persistence: "encrypted" }],
    remoteConfig: async (): Promise<DesktopConnectionConfig> => ({
      kind: "remote", profileId: PROFILE, controlUrl: "ws://remote/control", terminalUrl: "ws://remote/terminal",
      token: "0".repeat(64), terminalToken: "0".repeat(64),
      credential: { deviceId: "a".repeat(32), privateKey: {}, serverFingerprint: `sha256:${"b".repeat(64)}` },
    }),
  };
  const sockets: ReturnType<typeof socketFixture>[] = [];
  const registry = new ConnectionRegistry(
    { invalidated: vi.fn(), statusChanged: vi.fn() }, profiles as never,
    (config) => new TermLoopControlClient(config.controlUrl, config.token, () => {
      const socket = socketFixture();
      sockets.push(socket);
      return socket;
    }),
  );
  return { registry, sockets };
}

function socketFixture() {
  const listeners = new Map<string, (event: any) => void>();
  const sent: Array<{ id: string; method: string }> = [];
  return {
    sent,
    // A dead route can leave the WebSocket open indefinitely, with no close event.
    close: vi.fn(),
    addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); },
    send(raw: string) { sent.push(JSON.parse(raw)); },
    open() { listeners.get("open")?.({}); },
    reply(id: string, result: unknown) { listeners.get("message")?.({ data: JSON.stringify({ id, ok: true, result }) }); },
    fail(id: string) { listeners.get("message")?.({ data: JSON.stringify({ id, ok: false, error: { code: "capabilityDenied", message: "denied" } }) }); },
  };
}

afterEach(() => vi.useRealTimers());

describe("remote command connection recovery", () => {
  it("replaces a silent cached socket and retries the account read on a fresh connection", async () => {
    const { registry, sockets } = fixture();
    try {
      const result = registry.call(PROFILE, "agent.accountList");
      void result.catch(() => {});
      await flush();
      sockets[0]!.open();
      await flush();
      await vi.advanceTimersByTimeAsync(controlRequestTimeoutMs("agent.accountList"));
      await vi.advanceTimersByTimeAsync(2_000);
      await flush();
      expect(sockets).toHaveLength(2);
      expect(sockets[0]!.close).toHaveBeenCalledOnce();
      sockets[1]!.open();
      await flush();
      sockets[1]!.reply(sockets[1]!.sent[0]!.id, accounts);
      await expect(result).resolves.toEqual(accounts);
    } finally { registry.stopAll(); }
  });

  it("bounds the account retry and retires the second failed connection", async () => {
    const { registry, sockets } = fixture();
    try {
      const result = expect(registry.call(PROFILE, "agent.accountList")).rejects.toThrow(/timeout/);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await flush();
        sockets[attempt]!.open();
        await flush();
        await vi.advanceTimersByTimeAsync(controlRequestTimeoutMs("agent.accountList"));
        await vi.advanceTimersByTimeAsync(2_000);
      }
      await result;
      expect(sockets).toHaveLength(2);
      expect(sockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
    } finally { registry.stopAll(); }
  });

  it("never repeats a mutation whose response was lost, but gives the next call a fresh socket", async () => {
    const { registry, sockets } = fixture();
    try {
      const mutation = expect(registry.call(PROFILE, "project.delete", { projectId: "project" })).rejects.toThrow("request timeout");
      await flush();
      sockets[0]!.open();
      await flush();
      await vi.advanceTimersByTimeAsync(controlRequestTimeoutMs("project.delete"));
      await vi.advanceTimersByTimeAsync(2_000);
      await mutation;
      expect(sockets.flatMap((socket) => socket.sent).filter((request) => request.method === "project.delete")).toHaveLength(1);
      const result = registry.call(PROFILE, "agent.accountList");
      void result.catch(() => {});
      await flush();
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      await flush();
      sockets[1]!.reply(sockets[1]!.sent[0]!.id, accounts);
      await expect(result).resolves.toEqual(accounts);
    } finally { registry.stopAll(); }
  });

  it("does not retry an account read denied by the server", async () => {
    const { registry, sockets } = fixture();
    try {
      const result = expect(registry.call(PROFILE, "agent.accountList")).rejects.toThrow("denied");
      await flush();
      sockets[0]!.open();
      await flush();
      sockets[0]!.fail(sockets[0]!.sent[0]!.id);
      await result;
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.close).not.toHaveBeenCalled();
    } finally { registry.stopAll(); }
  });

  it("keeps a responsive connection and concurrent command alive when only the account read is slow", async () => {
    const { registry, sockets } = fixture();
    try {
      const result = registry.call(PROFILE, "agent.accountList");
      void result.catch(() => {});
      const concurrent = registry.call(PROFILE, "agent.authStatusList", {});
      void concurrent.catch(() => {});
      await flush();
      sockets[0]!.open();
      await flush();
      const originalAccountId = sockets[0]!.sent.find((request) => request.method === "agent.accountList")!.id;
      const concurrentId = sockets[0]!.sent.find((request) => request.method === "agent.authStatusList")!.id;
      await vi.advanceTimersByTimeAsync(controlRequestTimeoutMs("agent.accountList"));
      const ping = sockets[0]!.sent.find((request) => request.method === "system.ping")!;
      sockets[0]!.reply(ping.id, { pong: true });
      await flush();
      const retry = sockets[0]!.sent.filter((request) => request.method === "agent.accountList").at(-1)!;
      expect(retry.id).not.toBe(originalAccountId);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.close).not.toHaveBeenCalled();
      sockets[0]!.reply(retry.id, accounts);
      sockets[0]!.reply(concurrentId, []);
      await expect(result).resolves.toEqual(accounts);
      await expect(concurrent).resolves.toEqual([]);
    } finally { registry.stopAll(); }
  });

  it("coalesces simultaneous timeout probes and shares one replacement connection", async () => {
    const { registry, sockets } = fixture();
    try {
      const first = registry.call(PROFILE, "agent.accountList");
      const second = registry.call(PROFILE, "agent.accountList");
      void first.catch(() => {});
      void second.catch(() => {});
      await flush();
      sockets[0]!.open();
      await flush();
      await vi.advanceTimersByTimeAsync(controlRequestTimeoutMs("agent.accountList"));
      expect(sockets[0]!.sent.filter((request) => request.method === "system.ping")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      await flush();
      expect(sockets).toHaveLength(2);
      expect(sockets[0]!.close).toHaveBeenCalledOnce();
      sockets[1]!.open();
      await flush();
      for (const request of sockets[1]!.sent) sockets[1]!.reply(request.id, accounts);
      await expect(Promise.all([first, second])).resolves.toEqual([accounts, accounts]);
      expect(sockets[1]!.close).not.toHaveBeenCalled();
    } finally { registry.stopAll(); }
  });
});
