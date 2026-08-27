import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ACCESS_PROTOCOL_IDENTITY } from "@termloop/contract/current";

import {
  TailscaleServerDiscoveryManager,
  probeTermLoopTailscalePeer,
} from "../src/main/tailscale-discovery.js";

const FINGERPRINT = `sha256:${"b".repeat(64)}`;

describe("Tailscale TermLoop discovery", () => {
  it("recognizes a shared peer from its enrollment challenge without enrolling", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected test server address");
    let receivedExchange = false;
    let validChallenge = true;
    server.on("connection", (socket, request) => {
      expect(request.url).toBe("/enroll");
      socket.on("message", () => { receivedExchange = true; });
      socket.send(JSON.stringify({
        kind: validChallenge ? "pairChallenge" : "notTermLoop",
        protocolVersion: ACCESS_PROTOCOL_IDENTITY,
        serverFingerprint: FINGERPRINT,
      }));
    });

    try {
      await expect(probeTermLoopTailscalePeer({
        name: "Studio",
        dnsName: "studio.example-tailnet.ts.net",
        baseUrl: `ws://127.0.0.1:${address.port}`,
      })).resolves.toEqual({
        name: "Studio",
        dnsName: "studio.example-tailnet.ts.net",
        baseUrl: `ws://127.0.0.1:${address.port}`,
        serverFingerprint: FINGERPRINT,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(receivedExchange).toBe(false);
      validChallenge = false;
      await expect(probeTermLoopTailscalePeer({
        name: "Generic service",
        dnsName: "generic.example-tailnet.ts.net",
        baseUrl: `ws://127.0.0.1:${address.port}`,
      })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("coalesces overlapping scans and clears the completed scan", async () => {
    const peer = {
      name: "Studio",
      dnsName: "studio.example-tailnet.ts.net",
      baseUrl: "wss://studio.example-tailnet.ts.net:43717",
    };
    const listPeers = vi.fn(async () => [peer]);
    const probe = vi.fn(async () => ({ ...peer, serverFingerprint: FINGERPRINT }));
    const discovery = new TailscaleServerDiscoveryManager(listPeers, probe);

    const first = discovery.discover();
    const second = discovery.discover();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({
      state: "ready",
      servers: [{ ...peer, serverFingerprint: FINGERPRINT }],
    });
    await discovery.discover();

    expect(listPeers).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable unavailable state instead of throwing", async () => {
    const discovery = new TailscaleServerDiscoveryManager(
      async () => { throw new Error("Tailscale is signed out"); },
      vi.fn(),
    );
    await expect(discovery.discover()).resolves.toEqual({
      state: "unavailable",
      servers: [],
      message: "Tailscale is signed out",
    });
  });
});
