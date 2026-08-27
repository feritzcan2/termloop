export function tailscaleAccessBaseUrl(input: string): string {
  if (input.length === 0 || input.length > 2_048) {
    throw new Error("Tailscale address must be a valid wss:// URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Tailscale address must be a valid wss:// URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && loopback)) {
    throw new Error("Remote Tailscale profiles require wss://; plaintext ws:// is allowed only on loopback");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Connection URLs cannot contain credentials, query parameters, or fragments");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("Connection URL must identify the access-plane origin, without an endpoint path");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function accessEndpoint(baseUrl: string, endpoint: "control" | "terminal" | "pair" | "enroll" | "forward"): string {
  return `${baseUrl}/${endpoint}`;
}
