import type { AppUpdateResult } from "./app-update";

export type AppUpdateDiagnosticEvent =
  | "runtime_initialized"
  | "check_started"
  | "check_finished"
  | "check_failed";

export interface AppUpdateIdentity {
  readonly updateId: string | null;
  readonly channel: string | null;
  readonly runtimeVersion: string | null;
  readonly embedded: boolean;
  readonly appVersion: string | null;
  readonly appBuild: string | null;
}

export interface AppUpdateDiagnosticDetails {
  readonly requestedGroup?: string;
  readonly result?: AppUpdateResult;
  readonly cause?: unknown;
}

export interface AppUpdateDiagnostic {
  readonly message: `mobile.update.${AppUpdateDiagnosticEvent}`;
  readonly level: "info" | "error";
  readonly attributes: Readonly<Record<string, string | boolean>>;
}

function failureType(cause: unknown): string {
  if (cause instanceof Error) return cause.name || "Error";
  if (cause === null) return "null";
  return typeof cause;
}

export function mobileAppUpdateDiagnostic(
  event: AppUpdateDiagnosticEvent,
  identity: AppUpdateIdentity,
  details: AppUpdateDiagnosticDetails = {},
): AppUpdateDiagnostic {
  const attributes: Record<string, string | boolean> = {
    "expo.update": identity.updateId ?? "embedded",
    "expo.channel": identity.channel ?? "embedded",
    "expo.runtime": identity.runtimeVersion ?? "unknown",
    "expo.embedded": identity.embedded,
    "app.version": identity.appVersion ?? "unknown",
    "app.build": identity.appBuild ?? "unknown",
  };

  if (details.requestedGroup !== undefined) {
    attributes.requestedUpdateGroup = details.requestedGroup;
  }
  if (details.result !== undefined) {
    attributes.result = details.result;
  }
  if (event === "check_failed") {
    attributes.failureType = failureType(details.cause);
  }

  return {
    message: `mobile.update.${event}`,
    level: event === "check_failed" ? "error" : "info",
    attributes,
  };
}
