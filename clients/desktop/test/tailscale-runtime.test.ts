import { describe, expect, it } from "vitest";

import {
  configureTailscaleServe,
  disableTermLoopTailscaleServe,
  inspectServeJson,
  inspectTailscaleServe,
  parseOnlineTailscalePeers,
  parseTailscaleNodeStatus,
  type TailscaleCommandRunner,
} from "../src/platform/tailscale-runtime.js";

const PORT = 43_717;
const DNS_NAME = "studio.example-tailnet.ts.net";
const NODE_STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: `${DNS_NAME}.` },
});

describe("Tailscale Serve runtime", () => {
  it("lists only bounded online peers with valid MagicDNS names", () => {
    expect(parseOnlineTailscalePeers(JSON.stringify({
      BackendState: "Running",
      Peer: {
        first: { Online: true, DNSName: "studio.example-tailnet.ts.net.", HostName: "Studio" },
        second: { Online: false, DNSName: "offline.example-tailnet.ts.net.", HostName: "Offline" },
        invalid: { Online: true, DNSName: "attacker.invalid", HostName: "Invalid" },
      },
    }))).toEqual([{
      name: "Studio",
      dnsName: "studio.example-tailnet.ts.net",
      baseUrl: "wss://studio.example-tailnet.ts.net:43717",
    }]);
    expect(() => parseOnlineTailscalePeers(JSON.stringify({ BackendState: "NeedsLogin" })))
      .toThrow(/not connected/i);
  });

  it("derives a bounded wss origin only from a connected Tailscale node", () => {
    expect(parseTailscaleNodeStatus(NODE_STATUS, PORT)).toEqual({
      baseUrl: `wss://${DNS_NAME}:${PORT}`,
    });
    expect(() => parseTailscaleNodeStatus(JSON.stringify({
      BackendState: "NeedsLogin",
      Self: { DNSName: `${DNS_NAME}.` },
    }), PORT)).toThrow(/not connected/i);
    expect(() => parseTailscaleNodeStatus(JSON.stringify({
      BackendState: "Running",
      Self: { DNSName: "attacker.invalid" },
    }), PORT)).toThrow(/MagicDNS/i);
  });

  it("recognizes only the TermLoop loopback target and refuses a port conflict", () => {
    expect(inspectServeJson(JSON.stringify({
      Web: {
        [`${DNS_NAME}:${PORT}`]: {
          Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } },
        },
      },
    }), PORT)).toEqual({ state: "ready", baseUrl: `wss://${DNS_NAME}:${PORT}` });

    expect(inspectServeJson(JSON.stringify({
      Web: {
        [`${DNS_NAME}:${PORT}`]: {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
    }), PORT)).toMatchObject({ state: "conflict" });
  });

  it("configures a dedicated HTTPS route without resetting other Serve state", async () => {
    let configured = false;
    const calls: string[][] = [];
    const runner: TailscaleCommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "status") return { stdout: NODE_STATUS, stderr: "" };
      if (args[0] === "serve" && args[1] === "status") {
        return {
          stdout: configured ? JSON.stringify({
            Web: {
              [`${DNS_NAME}:${PORT}`]: {
                Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } },
              },
            },
          }) : "{}",
          stderr: "",
        };
      }
      configured = true;
      return { stdout: "", stderr: "" };
    };

    await expect(configureTailscaleServe(PORT, runner)).resolves.toBe(`wss://${DNS_NAME}:${PORT}`);
    expect(calls).toContainEqual([
      "serve",
      "--bg",
      "--yes",
      `--https=${PORT}`,
      `http://127.0.0.1:${PORT}`,
    ]);
    expect(calls.some((args) => args.includes("reset"))).toBe(false);
  });

  it("removes only a matching TermLoop route", async () => {
    const calls: string[][] = [];
    const runner: TailscaleCommandRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "status") return { stdout: NODE_STATUS, stderr: "" };
      return {
        stdout: JSON.stringify({
          Web: {
            [`${DNS_NAME}:${PORT}`]: {
              Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } },
            },
          },
        }),
        stderr: "",
      };
    };

    await disableTermLoopTailscaleServe(PORT, runner);
    expect(calls.at(-1)).toEqual(["serve", "--yes", `--https=${PORT}`, "off"]);
  });

  it("reports an available node when no Serve route exists", async () => {
    const runner: TailscaleCommandRunner = async (args) => ({
      stdout: args[0] === "status" ? NODE_STATUS : "{}",
      stderr: "",
    });
    await expect(inspectTailscaleServe(PORT, runner)).resolves.toEqual({
      state: "available",
      baseUrl: `wss://${DNS_NAME}:${PORT}`,
    });
  });
});
