import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  ACCESS_PROTOCOL_IDENTITY,
  CONTRACT_IDENTITY,
} from "@termloop/contract/current";

import type { RemoteConnectionConfig } from "../src/main/connection-profiles.js";
import { ForwardManager } from "../src/main/forwarding.js";
import type { LoopbackForwardConnection } from "../src/platform/loopback-forward-runtime.js";

describe("remote localhost forwarding", () => {
  it("keeps equal remote ports isolated by connection source", async () => {
    const closes = [vi.fn(), vi.fn()];
    const localPorts = [43_891, 49_123];
    const listeners: number[] = [];
    const baseConfig = {
      kind: "remote" as const,
      controlUrl: "ws://127.0.0.1:43890/control",
      terminalUrl: "ws://127.0.0.1:43890/terminal",
      token: "0".repeat(64),
      terminalToken: "0".repeat(64),
      credential: {
        deviceId: "a".repeat(32),
        privateKey: {},
        serverFingerprint: `sha256:${"b".repeat(64)}`,
      },
    };
    const first = { ...baseConfig, profileId: "server-a" };
    const second = { ...baseConfig, profileId: "server-b" };
    const manager = new ForwardManager(
      async () => undefined,
      async (preferredPort) => {
        const index = listeners.length;
        listeners.push(preferredPort);
        return { port: localPorts[index]!, close: closes[index]! };
      },
    );

    expect(await manager.localUrl("http://localhost:43891/path", first)).toBe(
      "http://localhost:43891/path",
    );
    expect(await manager.localUrl("http://localhost:43891/path", second)).toBe(
      "http://localhost:49123/path",
    );
    expect(listeners).toEqual([43_891, 43_891]);

    manager.stopProfile(first.profileId);
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(closes[1]).not.toHaveBeenCalled();
    manager.stop();
    expect(closes[1]).toHaveBeenCalledOnce();
  });

  it("bridges bytes when the access server responds immediately during every handshake phase", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected test server address");
    const fingerprint = `sha256:${"b".repeat(64)}`;
    server.on("connection", (peer) => {
      peer.send(JSON.stringify({
        kind: "challenge",
        protocolVersion: ACCESS_PROTOCOL_IDENTITY,
        controlProtocolVersion: CONTRACT_IDENTITY,
        channel: "forward",
        nonce: "A".repeat(43),
        serverFingerprint: fingerprint,
      }));
      peer.once("message", () => {
        peer.send(JSON.stringify({
          kind: "authenticated",
          protocolVersion: ACCESS_PROTOCOL_IDENTITY,
          deviceId: "a".repeat(32),
          scope: "full",
          connectionToken: "c".repeat(64),
        }));
        peer.once("message", (raw) => {
          const opened = JSON.parse(String(raw)) as { port: number };
          peer.send(JSON.stringify({
            kind: "forwardOpened",
            protocolVersion: ACCESS_PROTOCOL_IDENTITY,
            port: opened.port,
          }));
          peer.on("message", (bytes, binary) => { if (binary) peer.send(bytes, { binary: true }); });
        });
      });
    });
    const config: RemoteConnectionConfig = {
      kind: "remote",
      profileId: "profile",
      controlUrl: `ws://127.0.0.1:${address.port}/control`,
      terminalUrl: `ws://127.0.0.1:${address.port}/terminal`,
      token: "0".repeat(64),
      terminalToken: "0".repeat(64),
      credential: {
        deviceId: "a".repeat(32),
        privateKey: generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
        serverFingerprint: fingerprint,
      },
    };
    let acceptLocalConnection: ((connection: LoopbackForwardConnection) => void) | undefined;
    let localData: ((bytes: Uint8Array) => void) | undefined;
    let localClose: (() => void) | undefined;
    let closed = false;
    let resolveEcho: ((bytes: Buffer) => void) | undefined;
    const echoed = new Promise<Buffer>((resolve) => { resolveEcho = resolve; });
    const localConnection: LoopbackForwardConnection = {
      onData(listener) { localData = listener; },
      onDrain() {},
      onError() {},
      onClose(listener) { localClose = listener; },
      isClosed: () => closed,
      write(bytes) { resolveEcho?.(Buffer.from(bytes)); return true; },
      pause() {},
      resume() {},
      end() { closed = true; localClose?.(); },
      destroy() { closed = true; localClose?.(); },
    };
    const manager = new ForwardManager(
      async () => config,
      async (preferredPort, onConnection) => {
        acceptLocalConnection = onConnection;
        return { port: preferredPort, close() {} };
      },
    );

    try {
      const localUrl = new URL(await manager.localUrl("http://localhost:43891/path", config));
      acceptLocalConnection?.(localConnection);
      await waitUntil(() => localData !== undefined);
      localData?.(Buffer.from("forwarded"));
      expect((await echoed).toString()).toBe("forwarded");
      expect(localUrl.pathname).toBe("/path");
    } finally {
      manager.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function waitUntil(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error("forward bridge did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
