import { describe, expect, it } from "vitest";
import type { AccessStatusDto } from "@termloop/contract/current";

import { RemoteHostManager } from "../src/main/remote-host.js";

const PORT = 43_717;
const FINGERPRINT = `sha256:${"b".repeat(64)}`;

function accessStatus(enabled: boolean): AccessStatusDto {
  return {
    enabled,
    listening: enabled,
    port: enabled ? PORT : null,
    access_url: enabled ? `ws://127.0.0.1:${PORT}` : null,
    server_fingerprint: FINGERPRINT,
    error: null,
  };
}

describe("RemoteHostManager", () => {
  it("enables discoverable Tailscale sharing without creating an invitation", async () => {
    const calls: string[] = [];
    let status = accessStatus(false);
    const manager = new RemoteHostManager({
      status: async () => { calls.push("status"); return status; },
      enable: async () => { calls.push("enable"); status = accessStatus(true); return status; },
      disable: async () => accessStatus(false),
      inspectTailscale: async () => ({ state: "available", baseUrl: "wss://studio.example.ts.net:43717" }),
      configureTailscale: async () => {
        calls.push("tailscale");
        return "wss://studio.example.ts.net:43717";
      },
      disableTailscale: async () => undefined,
    });

    await expect(manager.enable("tailscale")).resolves.toMatchObject({
      enabled: true,
      tailscale: { state: "ready", baseUrl: "wss://studio.example.ts.net:43717" },
    });
    expect(calls).toEqual(["status", "enable", "tailscale"]);
  });

  it("enables SSH sharing without invoking Tailscale", async () => {
    const calls: string[] = [];
    let status = accessStatus(false);
    const manager = new RemoteHostManager({
      status: async () => { calls.push("status"); return status; },
      enable: async () => { calls.push("enable"); status = accessStatus(true); return status; },
      disable: async () => { calls.push("disable"); status = accessStatus(false); return status; },
      inspectTailscale: async () => ({ state: "available", baseUrl: "wss://studio.example.ts.net:43717" }),
      configureTailscale: async () => {
        calls.push("tailscale");
        return "wss://studio.example.ts.net:43717";
      },
      disableTailscale: async () => { calls.push("tailscaleOff"); },
    });

    await expect(manager.enable("ssh")).resolves.toMatchObject({
      enabled: true,
      listening: true,
    });
    expect(calls).toEqual(["status", "enable"]);
  });

  it("turns off the access plane before best-effort Serve cleanup", async () => {
    const calls: string[] = [];
    const manager = new RemoteHostManager({
      status: async () => accessStatus(true),
      enable: async () => accessStatus(true),
      disable: async () => { calls.push("disable"); return accessStatus(false); },
      inspectTailscale: async () => ({ state: "available", baseUrl: "wss://studio.example.ts.net:43717" }),
      configureTailscale: async () => "wss://studio.example.ts.net:43717",
      disableTailscale: async () => { calls.push("tailscaleOff"); throw new Error("offline"); },
    });

    await expect(manager.disable()).resolves.toMatchObject({
      enabled: false,
      warning: expect.stringMatching(/disabled/),
    });
    expect(calls).toEqual(["disable", "tailscaleOff"]);
  });
});
