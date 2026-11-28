import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const INSTALLATION_ID_FILE = "telemetry-installation-id";
export const LOCAL_MARKER_FILE = "telemetry-local";
const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type TelemetryEnvironment = "production" | "local";

export type TelemetryEnvironmentInput = {
  packaged: boolean;
  environmentOverride: string | undefined;
  localMarkerExists: boolean;
};

/**
 * Unpackaged development runs are always local. A packaged install on a
 * developer machine opts out of production counts with the marker file in its
 * user data directory or with TERMLOOP_TELEMETRY_ENVIRONMENT=local.
 */
export function telemetryEnvironment(input: TelemetryEnvironmentInput): TelemetryEnvironment {
  if (!input.packaged || input.localMarkerExists || input.environmentOverride === "local") return "local";
  return "production";
}

export function telemetryDisabled(dsn: string | undefined, smoke: boolean, setting: string | undefined): boolean {
  return !dsn || smoke || setting === "off";
}

/** A random identifier per user data directory; it carries no machine or user data. */
export function telemetryInstallationId(userDataPath: string, createId: () => string = randomUUID): string {
  const file = path.join(userDataPath, INSTALLATION_ID_FILE);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (INSTALLATION_ID.test(existing)) return existing;
  } catch {
    // A missing or unreadable identifier is replaced below.
  }
  const created = createId();
  try {
    writeFileSync(file, `${created}\n`, { mode: 0o600 });
  } catch {
    // Without a persisted identifier this run still counts once.
  }
  return created;
}

const PREFERENCE_FILE = "telemetry-preferences.json";

/** Reporting is on unless the user turned it off in Settings. */
export function readTelemetryEnabled(userDataPath: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(userDataPath, PREFERENCE_FILE), "utf8"));
    if (typeof value === "object" && value !== null && typeof (value as { enabled?: unknown }).enabled === "boolean") {
      return (value as { enabled: boolean }).enabled;
    }
  } catch {
    // A missing or unreadable preference keeps the default.
  }
  return true;
}

export function writeTelemetryEnabled(userDataPath: string, enabled: boolean): void {
  writeFileSync(path.join(userDataPath, PREFERENCE_FILE), `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
}

/** Replaces the user's home directory in every string of a report with `~`. */
export function scrubHomeDirectory<T>(value: T, homeDirectory: string): T {
  if (!homeDirectory || homeDirectory === "/" || value === undefined) return value;
  const encodedHome = JSON.stringify(homeDirectory).slice(1, -1);
  return JSON.parse(JSON.stringify(value).split(encodedHome).join("~")) as T;
}
