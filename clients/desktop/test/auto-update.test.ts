import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { autoUpdateSupported, windowsInstallerOwns } from "../src/platform/auto-update-policy.js";

describe("desktop auto-update platform policy", () => {
  it("never updates unpackaged development applications", () => {
    expect(autoUpdateSupported(false, "darwin", undefined)).toBe(false);
    expect(autoUpdateSupported(false, "win32", undefined, () => true)).toBe(false);
    expect(autoUpdateSupported(false, "linux", "/tmp/TermLoop.AppImage")).toBe(false);
  });

  it("supports packaged macOS, Windows, and Linux AppImage applications", () => {
    expect(autoUpdateSupported(true, "darwin", undefined)).toBe(true);
    expect(autoUpdateSupported(true, "win32", undefined, () => true)).toBe(true);
    expect(autoUpdateSupported(true, "linux", "/opt/TermLoop.AppImage")).toBe(true);
  });

  it("leaves Debian package updates to the system package manager", () => {
    expect(autoUpdateSupported(true, "linux", undefined)).toBe(false);
  });

  it("updates only the installed Windows app, never a checkout directory build", () => {
    expect(autoUpdateSupported(true, "win32", undefined, () => false)).toBe(false);
  });
});

describe("Windows installer ownership", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("recognizes the NSIS uninstaller beside the executable", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "termloop-nsis-"));
    const executable = path.join(directory, "TermLoop Next.exe");
    expect(windowsInstallerOwns(executable)).toBe(false);
    await writeFile(path.join(directory, "Uninstall TermLoop Next.exe"), "");
    expect(windowsInstallerOwns(executable)).toBe(true);
  });
});
