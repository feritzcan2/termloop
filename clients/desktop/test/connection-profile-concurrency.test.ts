import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ACCESS_PROTOCOL_IDENTITY } from "@termloop/contract/current";

const mocks = vi.hoisted(() => ({ spawnSshTunnel: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => "." },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("../src/platform/ssh-runtime.js", () => ({ spawnSshTunnel: mocks.spawnSshTunnel }));

import { ConnectionProfileStore } from "../src/main/connection-profiles.js";
import { ConnectionRegistry } from "../src/main/connection-registry.js";

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

async function enrollmentFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-concurrent-profiles-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  const fingerprint = `sha256:${"b".repeat(64)}`;
  let enrollments = 0;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ kind: "pairChallenge", protocolVersion: ACCESS_PROTOCOL_IDENTITY, serverFingerprint: fingerprint }));
    socket.once("message", () => {
      enrollments++;
      socket.send(JSON.stringify({
        kind: "enrolled", protocolVersion: ACCESS_PROTOCOL_IDENTITY,
        deviceId: "a".repeat(32), scope: "full", serverFingerprint: fingerprint,
      }));
    });
  });
  return {
    file: path.join(directory, "profiles.json"), port: address.port,
    baseUrl: `ws://127.0.0.1:${address.port}`, fingerprint,
    enrollments: () => enrollments,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Connection profile committed snapshots", () => {
  it("keeps local and existing SSH RPCs and profile reads available while adding an offline server", async () => {
    const fixture = await enrollmentFixture();
    const store = new ConnectionProfileStore(fixture.file, "Test laptop");
    const rpcCalls: string[] = [];
    const registry = new ConnectionRegistry(
      { invalidated() {}, statusChanged() {} }, store,
      (config) => ({ call: async (method: string) => { rpcCalls.push(`${config.kind}:${method}`); return []; }, close() {} }) as never,
    );
    for (const [key, value] of Object.entries({
      TERMLOOP_CONTROL_URL: "ws://127.0.0.1:1", TERMLOOP_TOKEN: "test",
      TERMLOOP_TERMINAL_URL: "ws://127.0.0.1:1", TERMLOOP_TERMINAL_TOKEN: "test",
    })) vi.stubEnv(key, value);
    let failConnect: ((error: Error) => void) | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      let began!: () => void;
      const connecting = new Promise<void>((resolve) => { began = resolve; });
      mocks.spawnSshTunnel.mockImplementation(({ host }: { host: string }) => {
        if (host === "offline.example") {
          return new Promise((_resolve, reject) => { failConnect = reject; began(); });
        }
        return Promise.resolve({ localPort: fixture.port, onExit() {}, stop() {} });
      });
      const { profile } = await store.connect({
        name: "Existing SSH", transport: { kind: "ssh", host: "existing.example", remotePort: 43717 },
      });
      // Completion of a write guarantees subsequent readers see its committed result.
      expect((await store.list()).find(({ id }) => id === profile.id)?.enabled).toBe(true);
      await registry.call("local", "project.list");
      rpcCalls.length = 0;
      pending = store.connect({
        name: "Offline", transport: { kind: "ssh", host: "offline.example", remotePort: 43717 },
      }).catch((error: unknown) => error);
      await connecting;
      const results = await within(Promise.all([
        store.list(), store.enabledSourceIds(), store.layoutMigrationProfileId(),
        store.remoteConfig(profile.id), registry.connectionConfig(profile.id),
        registry.call("local", "project.list"), registry.call(profile.id, "project.list"),
      ]));
      expect(results[0].map(({ id }) => id)).toEqual(["local", profile.id]);
      expect(results[1]).toEqual(["local", profile.id]);
      expect(results[2]).toBe("local");
      expect(results[3]).toMatchObject({ kind: "remote", profileId: profile.id });
      expect(results[4]).toMatchObject({ kind: "remote", profileId: profile.id });
      expect(rpcCalls.sort()).toEqual(["local:project.list", "remote:project.list"]);
      failConnect!(new Error("offline"));
      await expect(pending).resolves.toMatchObject({ message: "offline" });
      expect(await store.enabledSourceIds()).toEqual(["local", profile.id]);
    } finally {
      failConnect?.(new Error("test cleanup"));
      await pending;
      registry.stopAll();
      store.stop();
      await fixture.close();
    }
  });

  it("serializes competing additions so the enabled limit is checked before enrollment", async () => {
    const fixture = await enrollmentFixture();
    const ids = Array.from({ length: 6 }, () => randomUUID());
    await writeFile(fixture.file, JSON.stringify({
      version: 2, enabledProfileIds: ids,
      profiles: ids.map((id, index) => ({
        id, name: `Existing ${index}`, transport: { kind: "tailscale", baseUrl: fixture.baseUrl },
        deviceId: "a".repeat(32), scope: "full", serverFingerprint: fixture.fingerprint,
        encryptedPrivateKey: "ciphertext",
      })),
    }));
    const store = new ConnectionProfileStore(fixture.file, "Test laptop");
    try {
      const results = await Promise.allSettled(["First", "Second"].map((name) => store.connect({
        name, transport: { kind: "tailscale", baseUrl: fixture.baseUrl },
      })));
      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected", reason: { message: "At most 8 computers can be enabled at once" } });
      expect(fixture.enrollments()).toBe(1);
      expect(await store.enabledSourceIds()).toHaveLength(8);
      expect((await store.list()).some(({ name }) => name === "First")).toBe(true);
      expect((await store.list()).some(({ name }) => name === "Second")).toBe(false);
    } finally {
      store.stop();
      await fixture.close();
    }
  });
});

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("unrelated profile reads waited for connection setup")), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
