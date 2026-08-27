import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  ACCESS_PROTOCOL_IDENTITY,
  CONTRACT_IDENTITY,
} from "@termloop/contract/current";

import { createControlSocket, remoteConnectionFailureMessage } from "../src/main/access-websocket.js";

describe("remote access control socket", () => {
  it("authenticates an immediate challenge and replaces the placeholder request token", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected test server address");
    const fingerprint = `sha256:${"b".repeat(64)}`;
    const connectionToken = "c".repeat(64);
    let receivedToken: string | undefined;
    server.on("connection", (peer) => {
      peer.send(JSON.stringify({
        kind: "challenge",
        protocolVersion: ACCESS_PROTOCOL_IDENTITY,
        controlProtocolVersion: CONTRACT_IDENTITY,
        channel: "control",
        nonce: "A".repeat(43),
        serverFingerprint: fingerprint,
      }));
      peer.once("message", () => {
        peer.send(JSON.stringify({
          kind: "authenticated",
          protocolVersion: ACCESS_PROTOCOL_IDENTITY,
          deviceId: "a".repeat(32),
          scope: "full",
          connectionToken,
        }));
        peer.once("message", (raw) => {
          const request = JSON.parse(String(raw)) as { id: string; token: string };
          receivedToken = request.token;
          peer.send(JSON.stringify({ id: request.id, ok: true, result: { pong: true } }));
        });
      });
    });
    const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const socket = createControlSocket({
      kind: "remote",
      profileId: "profile",
      controlUrl: `ws://127.0.0.1:${address.port}/control`,
      terminalUrl: `ws://127.0.0.1:${address.port}/terminal`,
      token: "0".repeat(64),
      terminalToken: "0".repeat(64),
      credential: {
        deviceId: "a".repeat(32),
        privateKey,
        serverFingerprint: fingerprint,
      },
    });

    try {
      await event(socket, "open");
      const response = event(socket, "message");
      socket.send(JSON.stringify({
        id: "ping",
        protocolVersion: CONTRACT_IDENTITY,
        token: "0".repeat(64),
        method: "system.ping",
        params: {},
      }));
      expect(JSON.parse(String((await response).data))).toMatchObject({ id: "ping", ok: true });
      expect(receivedToken).toBe(connectionToken);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects binary framing during the JSON access handshake", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected test server address");
    const fingerprint = `sha256:${"b".repeat(64)}`;
    server.on("connection", (peer) => {
      peer.send(Buffer.from(JSON.stringify({
        kind: "challenge",
        protocolVersion: ACCESS_PROTOCOL_IDENTITY,
        controlProtocolVersion: CONTRACT_IDENTITY,
        channel: "control",
        nonce: "A".repeat(43),
        serverFingerprint: fingerprint,
      })));
    });
    const socket = createControlSocket({
      kind: "remote",
      profileId: "binary-profile",
      controlUrl: `ws://127.0.0.1:${address.port}/control`,
      terminalUrl: `ws://127.0.0.1:${address.port}/terminal`,
      token: "0".repeat(64),
      terminalToken: "0".repeat(64),
      credential: {
        deviceId: "a".repeat(32),
        privateKey: generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
        serverFingerprint: fingerprint,
      },
    });

    try {
      await event(socket, "close");
      expect(remoteConnectionFailureMessage("binary-profile")).toMatch(/handshake response is invalid/);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function event(socket: ReturnType<typeof createControlSocket>, name: "open" | "message" | "close"): Promise<any> {
  return new Promise((resolve) => socket.addEventListener(name, resolve, { once: true }));
}
