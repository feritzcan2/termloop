import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[][] = [];
let signature = "Identifier=termloop_pm_daemon-0123\nSignature=adhoc\n";
let identities = '  1) 4DF40ED3C9C9E60DE6FF1E01688D2EBB5EDD50B8 "Apple Development: Dev (TEAM)"\n     1 valid identities found\n';

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: (file: string, args: string[], callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    calls.push([file, ...args]);
    if (file === "codesign" && args[0] === "-dv") callback(null, { stdout: "", stderr: signature });
    else if (file === "security") callback(null, { stdout: identities, stderr: "" });
    else callback(null, { stdout: "", stderr: "" });
  },
}));

const { signDevDaemon } = await import("../src/platform/daemon-process.js");
const darwin = process.platform === "darwin";

describe("signDevDaemon", () => {
  beforeEach(() => {
    calls.length = 0;
    signature = "Identifier=termloop_pm_daemon-0123\nSignature=adhoc\n";
  });

  it.runIf(darwin)("re-signs an ad-hoc daemon with the Apple Development identity under a stable identifier", async () => {
    await signDevDaemon("/build/termloop-pm-daemon", false);
    expect(calls.at(-1)).toEqual([
      "codesign", "--force", "--sign", "4DF40ED3C9C9E60DE6FF1E01688D2EBB5EDD50B8",
      "--identifier", "dev.termloop.pm.daemon", "--timestamp=none", "/build/termloop-pm-daemon",
    ]);
  });

  it.runIf(darwin)("leaves an already-signed daemon alone", async () => {
    signature = "Identifier=dev.termloop.pm.daemon\nAuthority=Apple Development: Dev (TEAM)\n";
    await signDevDaemon("/build/termloop-pm-daemon", false);
    expect(calls).toEqual([["codesign", "-dv", "/build/termloop-pm-daemon"]]);
  });

  it.runIf(darwin)("keeps the ad-hoc signature when no identity exists", async () => {
    const saved = identities;
    identities = "     0 valid identities found\n";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await signDevDaemon("/build/termloop-pm-daemon", false);
    identities = saved;
    warn.mockRestore();
    expect(calls.some((call) => call.includes("--force"))).toBe(false);
  });

  it("never touches a packaged daemon", async () => {
    await signDevDaemon("/app/daemon/termloop-pm-daemon", true);
    expect(calls).toEqual([]);
  });
});
