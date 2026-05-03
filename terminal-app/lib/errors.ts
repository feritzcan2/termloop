import { RpcCallError } from "./termloop-client";

export const CONNECT_MOBILE_HINT =
  "Open TermLoop on your Mac and enable Connect Mobile.";

export function friendlyTransportError(err: unknown): string {
  const code = err instanceof RpcCallError ? err.code : "";
  const msg = String((err as Error)?.message ?? err);
  if (code === "invalid_token" || code === "unauthorized") {
    return "Authentication rejected. Re-pair from Mac.";
  }
  if (/expired/i.test(msg)) {
    return "This pairing QR has expired. Generate a new one on your Mac.";
  }
  if (/TCP transport unavailable/i.test(msg)) {
    return (
      "Native TCP module not loaded. This requires a development build — " +
      "Expo Go cannot open raw sockets. Run `npx expo prebuild --clean`."
    );
  }
  if (/connect timeout/i.test(msg) || /ECONNREFUSED/i.test(msg)) {
    return CONNECT_MOBILE_HINT;
  }
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return "Host unreachable. Check Wi-Fi and that the Mac is awake.";
  }
  return msg;
}

export function isTerminalSurfaceStartingError(err: unknown): boolean {
  if (!(err instanceof RpcCallError)) return false;
  return (
    (err.code === "internal_error" &&
      /terminal surface not found/i.test(err.message)) ||
    (err.code === "not_found" && /surface/i.test(err.message))
  );
}
