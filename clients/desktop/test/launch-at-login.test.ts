import { describe, expect, it, vi } from "vitest";

import { launchAtLoginStatus, setLaunchAtLogin } from "../src/platform/launch-at-login.js";

function application(isPackaged: boolean, settings: { openAtLogin: boolean; status?: string }) {
  return {
    isPackaged,
    getLoginItemSettings: vi.fn(() => settings),
    setLoginItemSettings: vi.fn((next: { openAtLogin: boolean }) => { settings.openAtLogin = next.openAtLogin; }),
  };
}

describe("launch at login", () => {
  it("never registers an unpackaged development run", () => {
    const app = application(false, { openAtLogin: false });
    expect(launchAtLoginStatus(app, "darwin")).toEqual({ state: "unsupported", reason: "development" });
    expect(() => setLaunchAtLogin(app, true, "darwin")).toThrow("launchAtLoginUnsupported");
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("reports Linux as unsupported", () => {
    expect(launchAtLoginStatus(application(true, { openAtLogin: false }), "linux"))
      .toEqual({ state: "unsupported", reason: "platform" });
  });

  it("returns what the operating system reports after a change", () => {
    const app = application(true, { openAtLogin: false });
    expect(setLaunchAtLogin(app, true, "win32")).toEqual({ state: "available", enabled: true, requiresApproval: false });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
    expect(setLaunchAtLogin(app, false, "win32")).toEqual({ state: "available", enabled: false, requiresApproval: false });
  });

  it("shows a macOS item waiting for approval as on", () => {
    expect(launchAtLoginStatus(application(true, { openAtLogin: false, status: "requires-approval" }), "darwin"))
      .toEqual({ state: "available", enabled: true, requiresApproval: true });
  });
});
