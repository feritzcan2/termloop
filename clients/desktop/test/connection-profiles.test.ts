import { describe, expect, it, vi } from "vitest";
import { ACCESS_PROTOCOL_IDENTITY } from "@termloop/contract/current";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

vi.mock("electron", () => ({
  app: { getPath: () => "." },
  safeStorage: { isEncryptionAvailable: () => false },
}));

describe("ConnectionProfileStore", () => {
  it("shares one initial disk load across concurrent readers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-profile-load-"));
    const file = path.join(directory, "profiles.json");
    const profileId = "123e4567-e89b-42d3-a456-426614174000";
    await writeFile(file, JSON.stringify({
      version: 1,
      activeProfileId: profileId,
      profiles: [{
        id: profileId,
        name: "Remote server",
        transport: { kind: "tailscale", baseUrl: "wss://server.tailnet.ts.net" },
        deviceId: "a".repeat(32),
        scope: "full",
        serverFingerprint: `sha256:${"b".repeat(64)}`,
        encryptedPrivateKey: "ciphertext",
      }],
    }), { mode: 0o600 });

    try {
      const { ConnectionProfileStore } = await import("../src/main/connection-profiles.js");
      const store = new ConnectionProfileStore(file);
      const [profiles, enabledSources] = await Promise.all([
        store.list(),
        store.enabledSourceIds(),
      ]);

      expect(enabledSources).toEqual(["local", profileId]);
      expect(await store.layoutMigrationProfileId()).toBe(profileId);
      expect(profiles.find((profile) => profile.id === profileId)?.enabled).toBe(true);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        version: 2,
        enabledProfileIds: [profileId],
      });

      await Promise.all([store.setEnabled(profileId, false), store.setEnabled(profileId, true)]);
      const afterMutations = await store.list();
      expect(afterMutations.find((profile) => profile.id === profileId)?.enabled).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps eager connections at eight computers including this one", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "termloop-profile-cap-"));
    const file = path.join(directory, "profiles.json");
    const profileIds = Array.from({ length: 8 }, (_, index) => (
      `123e4567-e89b-42d3-a456-42661417400${index}`
    ));
    await writeFile(file, JSON.stringify({
      version: 2,
      enabledProfileIds: profileIds.slice(0, 7),
      profiles: profileIds.map((id, index) => ({
        id,
        name: `Server ${index}`,
        transport: { kind: "tailscale", baseUrl: `wss://server-${index}.tailnet.ts.net` },
        deviceId: "a".repeat(32),
        scope: "full",
        serverFingerprint: `sha256:${"b".repeat(64)}`,
        encryptedPrivateKey: "ciphertext",
      })),
    }), { mode: 0o600 });

    try {
      const { ConnectionProfileStore } = await import("../src/main/connection-profiles.js");
      const store = new ConnectionProfileStore(file);
      await expect(store.setEnabled(profileIds[7]!, true)).rejects.toThrow(/At most 8 computers/);
      expect(await store.enabledSourceIds()).toEqual(["local", ...profileIds.slice(0, 7)]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the in-memory active profile unchanged when persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "termloop-profile-persist-"));
    const directory = path.join(root, "store");
    const file = path.join(directory, "profiles.json");
    const profileId = "123e4567-e89b-42d3-a456-426614174000";
    await mkdir(directory);
    await writeFile(file, JSON.stringify({
      version: 1,
      activeProfileId: profileId,
      profiles: [{
        id: profileId,
        name: "Remote server",
        transport: { kind: "tailscale", baseUrl: "wss://server.tailnet.ts.net" },
        deviceId: "a".repeat(32),
        scope: "full",
        serverFingerprint: `sha256:${"b".repeat(64)}`,
        encryptedPrivateKey: "ciphertext",
      }],
    }), { mode: 0o600 });

    try {
      const { ConnectionProfileStore } = await import("../src/main/connection-profiles.js");
      const store = new ConnectionProfileStore(file);
      expect(await store.enabledSourceIds()).toEqual(["local", profileId]);
      await rm(directory, { recursive: true, force: true });
      await writeFile(directory, "blocks profile directory recreation");

      await expect(store.setEnabled(profileId, false)).rejects.toThrow();
      expect(await store.enabledSourceIds()).toEqual(["local", profileId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enrolls over a loopback transport without persisting plaintext", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "termloop-profile-enroll-"));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected test server address");
    const fingerprint = `sha256:${"b".repeat(64)}`;
    server.on("connection", (socket, request) => {
      expect(request.url).toBe("/enroll");
      socket.send(JSON.stringify({
        kind: "pairChallenge",
        protocolVersion: ACCESS_PROTOCOL_IDENTITY,
        serverFingerprint: fingerprint,
      }));
      socket.once("message", (raw) => {
        const exchange = JSON.parse(String(raw)) as {
          kind: string;
          deviceName: string;
          serverFingerprint: string;
          pairingCode?: string;
        };
        expect(exchange.kind).toBe("enroll");
        expect(exchange.deviceName).toBe("Test laptop");
        expect(exchange.serverFingerprint).toBe(fingerprint);
        expect(exchange.pairingCode).toBeUndefined();
        socket.send(JSON.stringify({
          kind: "enrolled",
          protocolVersion: ACCESS_PROTOCOL_IDENTITY,
          deviceId: "a".repeat(32),
          scope: "full",
          serverFingerprint: fingerprint,
        }));
      });
    });

    try {
      const { ConnectionProfileStore } = await import("../src/main/connection-profiles.js");
      const store = new ConnectionProfileStore(path.join(root, "profiles.json"), "Test laptop");
      const result = await store.connect({
        name: "Remote server",
        expectedServerFingerprint: fingerprint,
        transport: { kind: "tailscale", baseUrl: `ws://127.0.0.1:${address.port}` },
      });

      expect(result.profile).toMatchObject({
        name: "Remote server",
        scope: "full",
        persistence: "sessionOnly",
        enabled: true,
      });
      await expect(import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "profiles.json"))))
        .rejects.toMatchObject({ code: "ENOENT" });
      store.stop();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not enroll when discovery and connection fingerprints differ", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "termloop-profile-fingerprint-"));
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected test server address");
    const expectedFingerprint = `sha256:${"b".repeat(64)}`;
    let receivedExchange = false;
    server.on("connection", (socket) => {
      socket.on("message", () => { receivedExchange = true; });
      socket.send(JSON.stringify({
        kind: "pairChallenge",
        protocolVersion: ACCESS_PROTOCOL_IDENTITY,
        serverFingerprint: `sha256:${"c".repeat(64)}`,
      }));
    });

    try {
      const { ConnectionProfileStore } = await import("../src/main/connection-profiles.js");
      const store = new ConnectionProfileStore(path.join(root, "profiles.json"));
      await expect(store.connect({
        name: "Wrong server",
        expectedServerFingerprint: expectedFingerprint,
        transport: { kind: "tailscale", baseUrl: `ws://127.0.0.1:${address.port}` },
      })).rejects.toThrow(/fingerprint/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(receivedExchange).toBe(false);
      store.stop();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an actionable connection failure when enrollment never opens", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "termloop-profile-connect-failure-"));
    try {
      const { ConnectionProfileStore } = await import("../src/main/connection-profiles.js");
      const store = new ConnectionProfileStore(path.join(root, "profiles.json"));
      await expect(store.connect({
        name: "Offline server",
        transport: { kind: "tailscale", baseUrl: "ws://127.0.0.1:1" },
      })).rejects.toThrow(/Could not reach the TermLoop server/);
      store.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
