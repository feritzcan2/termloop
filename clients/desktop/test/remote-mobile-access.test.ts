import { CONTRACT_IDENTITY } from "@termloop/contract/current";
import { describe, expect, it, vi } from "vitest";
import { prepareRemoteMobileAccess, remoteMobileAccessCommand } from "../src/platform/remote-mobile-access.js";
import { sshCommandArgs } from "../src/platform/ssh-runtime.js";

const request = { host: "netcup-alias", remotePort: 43717 };
const payload = {
  version: 1, connectionId: "mac-1234567890abcdef", name: "Netcup", protocolVersion: CONTRACT_IDENTITY,
  controlUrl: "wss://netcup.tailnet.ts.net/control", terminalUrl: "wss://netcup.tailnet.ts.net/terminal",
  controlToken: "a".repeat(64), terminalToken: "b".repeat(64),
};
const output = (value: Record<string, unknown> = payload) => JSON.stringify({ ok: true, pairingCode: `TLMP1:${JSON.stringify(value)}` });

describe("remote Mobile Access", () => {
  it("uses the saved SSH target and returns only QR geometry", async () => {
    const run = vi.fn(async () => output());
    const result = await prepareRemoteMobileAccess(request, run);
    expect(run).toHaveBeenCalledWith(request, remoteMobileAccessCommand);
    expect(remoteMobileAccessCommand).toContain('${XDG_DATA_HOME:-$HOME/.local/share}');
    expect(result).toMatchObject({ ok: true, qrSvg: expect.stringContaining("<svg") });
    expect(JSON.stringify(result)).not.toContain(payload.controlToken);
    expect(JSON.stringify(result)).not.toContain("TLMP1:");
  });

  it("preserves managed credentials and OpenSSH configuration while disabling forwards", () => {
    const args = sshCommandArgs({ ...request, user: "termloop-admin", sshPort: 2222, identityFile: "/keys/device", knownHostsFile: "/keys/known hosts" }, "fixed-command", true);
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain('UserKnownHostsFile="/keys/known hosts"');
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args).toContain("RemoteCommand=none");
    expect(args).not.toContain("-N");
    expect(args).not.toContain("-L");
    expect(args.slice(-2)).toEqual(["termloop-admin@netcup-alias", "fixed-command"]);
    expect(sshCommandArgs(request, "fixed-command")).not.toContain("-F");
    expect(() => sshCommandArgs({ ...request, host: "bad;host" }, "fixed-command")).toThrow();
  });

  it.each([
    ["packageMissing", "does not include Mobile Access"],
    ["tailscaleOffline", "same network"],
    ["tailscalePermission", "--operator"],
    ["linuxRequired", "Linux"],
  ])("offers actionable guidance for %s", async (errorCode, message) => {
    expect(await prepareRemoteMobileAccess(request, async () => JSON.stringify({ ok: false, errorCode })))
      .toMatchObject({ ok: false, error: expect.stringContaining(message) });
  });

  it("does not expose remote diagnostics or malformed pairing credentials", async () => {
    for (const run of [
      async () => { throw new Error(`secret ${payload.controlToken}`); },
      async () => JSON.stringify({ ok: false, errorCode: payload.controlToken }),
      async () => output({ ...payload, controlUrl: "https://attacker.example/control" }),
      async () => output({ ...payload, terminalUrl: "wss://other.ts.net/terminal" }),
      async () => "TLMP1:secret",
    ]) {
      const result = await prepareRemoteMobileAccess(request, run);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(payload.controlToken);
    }
  });

  it("refuses mismatched protocols before showing a QR", async () => {
    expect(await prepareRemoteMobileAccess(request, async () => output({ ...payload, protocolVersion: `sha256:${"0".repeat(64)}` })))
      .toMatchObject({ ok: false, error: expect.stringContaining("different protocols") });
  });
});
