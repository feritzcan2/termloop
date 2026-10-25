// Main-side validation for renderer IPC. Electron-free so the allowlist and
// the sender check are unit-testable.
import { isRendererMethod, type PmCallError } from "../pm-api.js";

export type ControlCaller = {
  call(method: string, params: object): Promise<unknown>;
};

export type CallOutcome = { ok: true; result: unknown } | { ok: false; error: PmCallError };

const MAX_PARAMS_BYTES = 512 * 1024;

/**
 * Forwards one renderer call when its method is on the renderer allowlist
 * and its params are a bounded plain object. Every failure crosses IPC as a
 * code and message only.
 */
export async function handleRendererCall(control: ControlCaller, method: unknown, params: unknown): Promise<CallOutcome> {
  if (!isRendererMethod(method)) {
    return { ok: false, error: { code: "methodNotAllowed", message: `method ${String(method).slice(0, 64)} is not available to the renderer` } };
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { ok: false, error: { code: "invalidParams", message: "params must be an object" } };
  }
  if (JSON.stringify(params).length > MAX_PARAMS_BYTES) {
    return { ok: false, error: { code: "requestTooLarge", message: "params are too large" } };
  }
  try {
    return { ok: true, result: await control.call(method, params) };
  } catch (error) {
    return { ok: false, error: callError(error) };
  }
}

export function callError(error: unknown): PmCallError {
  if (error instanceof Error) {
    const typed = error as Error & { code?: unknown; details?: unknown };
    return {
      code: typeof typed.code === "string" ? typed.code : "unavailable",
      message: error.message,
      ...(typed.details === undefined ? {} : { details: typed.details }),
    };
  }
  return { code: "unavailable", message: String(error) };
}

/** Only the main frame of the one PM window may use the bridge. */
export function isTrustedSender(
  expected: { webContents: unknown; mainFrame: unknown } | undefined,
  event: { sender: unknown; senderFrame: unknown },
): boolean {
  return expected !== undefined && event.sender === expected.webContents && event.senderFrame === expected.mainFrame;
}

/** External links open only for https URLs. */
export function isOpenableUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
