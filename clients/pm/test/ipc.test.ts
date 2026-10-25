import { describe, expect, it, vi } from "vitest";
import { handleRendererCall, isOpenableUrl, isTrustedSender } from "../src/main/ipc.js";
import { parseDiscovery } from "../src/main/daemon-lifecycle.js";
import { CONTRACT_IDENTITY } from "@termloop/pm-contract/pm";

describe("main-side renderer IPC", () => {
  it("rejects a method outside the renderer allowlist without reaching the daemon", async () => {
    const control = { call: vi.fn(async () => ({})) };
    for (const method of ["pm_unknown_method", "pm_subscribe", "pm_cancel", 42, undefined]) {
      const outcome = await handleRendererCall(control, method, {});
      expect(outcome).toMatchObject({ ok: false, error: { code: "methodNotAllowed" } });
    }
    expect(control.call).not.toHaveBeenCalled();
  });

  it("forwards an allowlisted method and maps daemon failures to code and message", async () => {
    const control = { call: vi.fn(async () => ({ product: "termloop-pm" })) };
    await expect(handleRendererCall(control, "pm_system_version", {})).resolves.toEqual({ ok: true, result: { product: "termloop-pm" } });
    expect(await handleRendererCall(control, "pm_system_version", [])).toMatchObject({ ok: false, error: { code: "invalidParams" } });
    control.call.mockRejectedValueOnce(Object.assign(new Error("stale base"), { code: "conflict" }));
    expect(await handleRendererCall(control, "pm_ticket_update", { ticketId: "t" })).toEqual({ ok: false, error: { code: "conflict", message: "stale base" } });
  });

  it("trusts only the PM window's main frame and opens only https links", () => {
    const window = { webContents: {}, mainFrame: {} };
    expect(isTrustedSender(window, { sender: window.webContents, senderFrame: window.mainFrame })).toBe(true);
    expect(isTrustedSender(window, { sender: window.webContents, senderFrame: {} })).toBe(false);
    expect(isTrustedSender(undefined, { sender: {}, senderFrame: {} })).toBe(false);
    expect(isOpenableUrl("https://acme.atlassian.net/browse/SHOP-7")).toBe(true);
    expect(isOpenableUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("PM discovery", () => {
  const valid = {
    protocolVersion: CONTRACT_IDENTITY, controlUrl: "ws://127.0.0.1:4100/control", terminalUrl: "ws://127.0.0.1:4100/terminal",
    token: "secret", scope: "pm.full", runtimeEpoch: 7, pid: 99,
  };
  it("accepts a loopback discovery record of this protocol", () => {
    expect(parseDiscovery(valid)).toMatchObject({ runtimeEpoch: 7, pid: 99 });
  });
  it("refuses another protocol or a non-loopback endpoint", () => {
    expect(() => parseDiscovery({ ...valid, protocolVersion: "other" })).toThrow(/protocol/);
    expect(() => parseDiscovery({ ...valid, controlUrl: "ws://10.0.0.2:4100/control" })).toThrow(/loopback/);
  });
});
