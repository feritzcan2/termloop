import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readTelemetryEnabled,
  scrubHomeDirectory,
  telemetryDisabled,
  telemetryEnvironment,
  telemetryInstallationId,
  writeTelemetryEnabled,
} from "./telemetry-policy.js";

const directories: string[] = [];
function userData(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "termloop-telemetry-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("desktop telemetry", () => {
  it("counts only packaged installs without a developer opt-out as production", () => {
    expect(telemetryEnvironment({ packaged: true, environmentOverride: undefined, localMarkerExists: false })).toBe("production");
    expect(telemetryEnvironment({ packaged: false, environmentOverride: undefined, localMarkerExists: false })).toBe("local");
    expect(telemetryEnvironment({ packaged: true, environmentOverride: undefined, localMarkerExists: true })).toBe("local");
    expect(telemetryEnvironment({ packaged: true, environmentOverride: "local", localMarkerExists: false })).toBe("local");
  });

  it("stays off without a DSN, during smoke runs, or when turned off", () => {
    expect(telemetryDisabled(undefined, false, undefined)).toBe(true);
    expect(telemetryDisabled("https://key@example.invalid/1", true, undefined)).toBe(true);
    expect(telemetryDisabled("https://key@example.invalid/1", false, "off")).toBe(true);
    expect(telemetryDisabled("https://key@example.invalid/1", false, undefined)).toBe(false);
  });

  it("keeps one random installation identifier per user data directory", () => {
    const directory = userData();
    const first = telemetryInstallationId(directory, () => "0b5c7a52-31f4-4d2e-9a77-2f1f0d6c9e10");
    const second = telemetryInstallationId(directory, () => "ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(first).toBe("0b5c7a52-31f4-4d2e-9a77-2f1f0d6c9e10");
    expect(second).toBe(first);
  });

  it("replaces a corrupted installation identifier", () => {
    const directory = userData();
    writeFileSync(path.join(directory, "telemetry-installation-id"), "hostname-or-garbage\n");
    const id = telemetryInstallationId(directory, () => "0b5c7a52-31f4-4d2e-9a77-2f1f0d6c9e10");
    expect(id).toBe("0b5c7a52-31f4-4d2e-9a77-2f1f0d6c9e10");
    expect(readFileSync(path.join(directory, "telemetry-installation-id"), "utf8").trim()).toBe(id);
  });

  it("reports by default and remembers when the user turns it off", () => {
    const directory = userData();
    expect(readTelemetryEnabled(directory)).toBe(true);
    writeTelemetryEnabled(directory, false);
    expect(readTelemetryEnabled(directory)).toBe(false);
    writeTelemetryEnabled(directory, true);
    expect(readTelemetryEnabled(directory)).toBe(true);
  });

  it("keeps the default when the preference file is unreadable", () => {
    const directory = userData();
    writeFileSync(path.join(directory, "telemetry-preferences.json"), "{not json");
    expect(readTelemetryEnabled(directory)).toBe(true);
  });

  it("replaces the home directory in every report string", () => {
    const report = { message: "ENOENT /Users/ada/projects/x", frames: [{ filename: "/Users/ada/app.js" }], count: 2 };
    expect(scrubHomeDirectory(report, "/Users/ada")).toEqual({ message: "ENOENT ~/projects/x", frames: [{ filename: "~/app.js" }], count: 2 });
    expect(scrubHomeDirectory({ path: "C:\\Users\\ada\\x" }, "C:\\Users\\ada")).toEqual({ path: "~\\x" });
    expect(scrubHomeDirectory({ path: "/etc" }, "/")).toEqual({ path: "/etc" });
  });
});
