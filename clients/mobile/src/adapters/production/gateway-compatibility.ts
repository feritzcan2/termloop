import type { SavedConnection } from "@/platform/secure-connections";

import { MOBILE_API_VERSION } from "./mobile-control-client";

const MOBILE_TRANSPORT_VERSION = 2;
const GATEWAY_PROBE_TIMEOUT_MS = 900;

export type GatewayCompatibilityProbe =
  | "reachable"
  | "unreachable"
  | "gatewayUpdateRequired"
  | "mobileUpdateRequired";

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
    requestWithTimeout(request, wellKnown.toString()),
    requestWithTimeout(request, health.toString()),
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

async function requestWithTimeout(request: typeof fetch, url: string): Promise<Response | undefined> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("Gateway compatibility probe timed out."));
      }, GATEWAY_PROBE_TIMEOUT_MS);
    });
    return await Promise.race([
      request(url, {
        headers: { accept: "application/json" },
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
