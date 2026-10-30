import type { ConnectionSourceState } from "../connection-profile-types.js";

/* Remote access rejects a server built from another contract with
   `Version mismatch: server …, desktop …`. The source is unreachable either
   way, but the user has to install a matching release rather than wait. */
export function isVersionMismatchMessage(message: string | undefined): boolean {
  return message?.startsWith("Version mismatch:") ?? false;
}

/** The ` · Offline` / ` · Version mismatch` suffix after a computer's name. */
export function connectionStatusSuffix(
  state: ConnectionSourceState | undefined,
  message: string | undefined,
): string {
  if (state !== "offline") return "";
  return isVersionMismatchMessage(message) ? " · Version mismatch" : " · Offline";
}
