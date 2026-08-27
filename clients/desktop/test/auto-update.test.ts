import { describe, expect, it } from "vitest";

import { autoUpdateSupported } from "../src/platform/auto-update-policy.js";

describe("desktop auto-update platform policy", () => {
  it("never updates unpackaged development applications", () => {
    expect(autoUpdateSupported(false, "darwin", undefined)).toBe(false);
    expect(autoUpdateSupported(false, "win32", undefined)).toBe(false);
    expect(autoUpdateSupported(false, "linux", "/tmp/TermLoop.AppImage")).toBe(false);
  });

  it("supports packaged macOS, Windows, and Linux AppImage applications", () => {
    expect(autoUpdateSupported(true, "darwin", undefined)).toBe(true);
    expect(autoUpdateSupported(true, "win32", undefined)).toBe(true);
    expect(autoUpdateSupported(true, "linux", "/opt/TermLoop.AppImage")).toBe(true);
  });

  it("leaves Debian package updates to the system package manager", () => {
    expect(autoUpdateSupported(true, "linux", undefined)).toBe(false);
  });
});
