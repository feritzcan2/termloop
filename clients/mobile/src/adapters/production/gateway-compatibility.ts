import type { SavedConnection } from "@/platform/secure-connections";

import { MOBILE_API_VERSION } from "./mobile-control-client";

const MOBILE_TRANSPORT_VERSION = 2;
const GATEWAY_PROBE_TIMEOUT_MS = 900;
const GATEWAY_WAKE_TIMEOUT_MS = 4_000;

export type GatewayCompatibilityProbe =
  | "reachable"
  | "unreachable"
  | "gatewayUpdateRequired"
  | "mobileUpdateRequired";

/// Proves the Tailnet route and gateway HTTP listener before iOS is allowed to
/// allocate another native WebSocket. A CONNECTING WebSocket can outlive its JS
/// wrapper for tens of seconds after `close()`, so blind retries accumulate stale
/// handshakes and only an app restart clears them. The secret-free health request
/// wakes the same route without creating another terminal transport.
export async function waitForGatewayReachability(
  connection: SavedConnection,
  request: typeof fetch,
): Promise<void> {
  const health = gatewayHttpEndpoint(connection, "/health");
  const response = await requestWithTimeout(request, health.toString(), GATEWAY_WAKE_TIMEOUT_MS);
  if (!response?.ok) throw new Error("Mobile gateway is not reachable.");
}

/// Distinguishes an unreachable Mac from a reachable persistent gateway that
/// predates the phone's transport. This endpoint is intentionally secret-free;
/// credentials remain in the WebSocket authentication message only.
export async function probeGatewayCompatibility(
  connection: SavedConnection,
  request: typeof fetch,
): Promise<GatewayCompatibilityProbe> {
  const wellKnown = gatewayHttpEndpoint(connection, "/.well-known/termloop-mobile-access");
  const health = gatewayHttpEndpoint(connection, "/health");
  // Probe both routes concurrently so an offline Mac adds at most one bounded
  // timeout. React Native provides AbortController but not AbortSignal.timeout.
  const [wellKnownResponse, healthResponse] = await Promise.all([
    requestWithTimeout(request, wellKnown.toString(), GATEWAY_PROBE_TIMEOUT_MS),
    requestWithTimeout(request, health.toString(), GATEWAY_PROBE_TIMEOUT_MS),
  ]);
  if (wellKnownResponse?.ok) {
    return gatewayIdentityCompatibility(await wellKnownResponse.json().catch(() => undefined));
  }
  if (!healthResponse?.ok) return "unreachable";
  const identity: unknown = await healthResponse.json().catch(() => undefined);
  // A reachable legacy gateway answers the established health route but has no
  // build identity. That is positive evidence for an update, not "Mac offline".
  return gatewayIdentityCompatibility(identity);
}

async function requestWithTimeout(
  request: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<Response | undefined> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Gateway compatibility probe timed out."));
      }, timeoutMs);
    });
    return await Promise.race([
      request(url, {
        cache: "no-store",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        signal: controller.signal,
      }),
      deadline,
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function gatewayHttpEndpoint(connection: SavedConnection, pathname: string): URL {
  const endpoint = new URL(connection.controlUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = pathname;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function gatewayIdentityCompatibility(value: unknown): GatewayCompatibilityProbe {
  const identity = value as {
    buildId?: unknown;
    compatibility?: {
      mobileTransport?: { min?: unknown; max?: unknown };
      mobileApi?: { min?: unknown; max?: unknown };
    };
  } | null;
  const transport = identity?.compatibility?.mobileTransport;
  const api = identity?.compatibility?.mobileApi;
  if (typeof identity?.buildId !== "string" || identity.buildId.length === 0
    || typeof transport?.min !== "number" || typeof transport.max !== "number"
    || typeof api?.min !== "number" || typeof api.max !== "number") {
    return "gatewayUpdateRequired";
  }
  if (MOBILE_TRANSPORT_VERSION < transport.min || MOBILE_API_VERSION < api.min) {
    return "mobileUpdateRequired";
  }
  if (MOBILE_TRANSPORT_VERSION > transport.max || MOBILE_API_VERSION > api.max) {
    return "gatewayUpdateRequired";
  }
  return "reachable";
}
