import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  IPCMode,
  childProcessIntegration,
  close,
  contextLinesIntegration,
  dedupeIntegration,
  electronContextIntegration,
  eventFiltersIntegration,
  functionToStringIntegration,
  init,
  linkedErrorsIntegration,
  mainProcessSessionIntegration,
  normalizePathsIntegration,
  onUncaughtExceptionIntegration,
  onUnhandledRejectionIntegration,
} from "@sentry/electron/main";

import type { TelemetryStatus } from "../telemetry-status.js";
import {
  LOCAL_MARKER_FILE,
  readTelemetryEnabled,
  scrubHomeDirectory,
  telemetryDisabled,
  telemetryEnvironment,
  telemetryInstallationId,
  writeTelemetryEnabled,
} from "./telemetry-policy.js";

// Public ingestion identifier for the termloop-desktop Sentry project.
const DESKTOP_SENTRY_DSN: string | undefined = "https://09427d44856b58e4f5bee51c0f54a4dc@o4511248981164032.ingest.de.sentry.io/4512508818227280";

export type DesktopTelemetryOptions = {
  packaged: boolean;
  smoke: boolean;
  version: string;
  userDataPath: string;
  environment: NodeJS.ProcessEnv;
};

let configured: DesktopTelemetryOptions | undefined;
let running = false;

function unavailable(options: DesktopTelemetryOptions | undefined): options is undefined {
  return !options || telemetryDisabled(DESKTOP_SENTRY_DSN, options.smoke, options.environment.TERMLOOP_TELEMETRY);
}

/**
 * Sends release-health sessions and main-process error reports. Breadcrumbs,
 * minidumps, local variables, screenshots, renderer instrumentation, IP
 * address, and host name are never collected; home directory paths are
 * replaced with `~`. Must run before the app is ready.
 */
export function startDesktopTelemetry(options: DesktopTelemetryOptions): void {
  configured = options;
  if (unavailable(options) || !readTelemetryEnabled(options.userDataPath)) return;
  const homeDirectory = os.homedir();
  init({
    dsn: DESKTOP_SENTRY_DSN,
    release: `termloop-desktop@${options.version}`,
    environment: telemetryEnvironment({
      packaged: options.packaged,
      environmentOverride: options.environment.TERMLOOP_TELEMETRY_ENVIRONMENT,
      localMarkerExists: existsSync(path.join(options.userDataPath, LOCAL_MARKER_FILE)),
    }),
    dataCollection: { userInfo: false },
    defaultIntegrations: false,
    integrations: [
      mainProcessSessionIntegration(),
      onUncaughtExceptionIntegration(),
      onUnhandledRejectionIntegration(),
      childProcessIntegration(),
      linkedErrorsIntegration(),
      functionToStringIntegration(),
      dedupeIntegration(),
      eventFiltersIntegration(),
      contextLinesIntegration(),
      electronContextIntegration(),
      // Runs last so app paths are normalized after context is captured.
      normalizePathsIntegration(),
    ],
    ipcMode: IPCMode.Classic,
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    initialScope: { user: { id: telemetryInstallationId(options.userDataPath) } },
    beforeSend(event) {
      delete event.request;
      delete event.server_name;
      delete event.breadcrumbs;
      if (event.user?.id) event.user = { id: event.user.id };
      else delete event.user;
      return scrubHomeDirectory(event, homeDirectory);
    },
    beforeSendTransaction: () => null,
  });
  running = true;
}

export function desktopTelemetryStatus(): TelemetryStatus {
  const options = configured;
  if (unavailable(options)) return { state: "unavailable" };
  const enabled = readTelemetryEnabled(options.userDataPath);
  return { state: "available", enabled, restartRequired: enabled && !running };
}

/** Turning reporting off stops it immediately; turning it on applies at next launch. */
export async function setDesktopTelemetryEnabled(enabled: boolean): Promise<TelemetryStatus> {
  const options = configured;
  if (unavailable(options)) throw new Error("telemetryUnavailable");
  writeTelemetryEnabled(options.userDataPath, enabled);
  if (!enabled && running) {
    running = false;
    await close(2000);
  }
  return desktopTelemetryStatus();
}
