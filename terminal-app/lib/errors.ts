import { RpcCallError } from "./termloop-client";

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
  if (/connect timeout/i.test(msg)) {
    return (
      "Couldn't reach the Mac before timeout. Check that it's on the same Wi-Fi " +
      "and TermLoop's Connect Mobile is enabled."
    );
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return "Connection refused. Make sure TermLoop is open and Connect Mobile is enabled.";
  }
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
    return "Host unreachable. Check Wi-Fi and that the Mac is awake.";
  }
  return msg;
}
