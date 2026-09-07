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

export type GatewayReachabilityFailureReason =
  | "timeout"
  | "requestRejected"
  | "httpResponse";

export type GatewayRequestSettlement =
  | { readonly kind: "response"; readonly httpStatus: number }
  | { readonly kind: "requestRejected"; readonly causeType: string };

export class GatewayReachabilityError extends Error {
  override readonly name = "GatewayReachabilityError";

  constructor(
    readonly reason: GatewayReachabilityFailureReason,
    readonly requestCauseType?: string,
    readonly httpStatus?: number,
    readonly lateSettlement?: Promise<GatewayRequestSettlement>,
  ) {
    super("Mobile gateway is not reachable.");
  }
}

type GatewayRequestOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "timeout"; readonly lateSettlement: Promise<GatewayRequestSettlement> }
  | { readonly kind: "requestRejected"; readonly causeType: string };

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
  const outcome = await requestWithTimeout(request, health.toString(), GATEWAY_WAKE_TIMEOUT_MS);
  if (outcome.kind === "timeout") {
    throw new GatewayReachabilityError("timeout", undefined, undefined, outcome.lateSettlement);
  }
  if (outcome.kind === "requestRejected") {
    throw new GatewayReachabilityError("requestRejected", outcome.causeType);
  }
  if (!outcome.response.ok) {
    throw new GatewayReachabilityError("httpResponse", undefined, outcome.response.status);
  }
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
  const [wellKnownOutcome, healthOutcome] = await Promise.all([
    requestWithTimeout(request, wellKnown.toString(), GATEWAY_PROBE_TIMEOUT_MS),
    requestWithTimeout(request, health.toString(), GATEWAY_PROBE_TIMEOUT_MS),
  ]);
  const wellKnownResponse = wellKnownOutcome.kind === "response"
    ? wellKnownOutcome.response
    : undefined;
  const healthResponse = healthOutcome.kind === "response"
    ? healthOutcome.response
    : undefined;
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
): Promise<GatewayRequestOutcome> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    let response: Promise<Response>;
    try {
      response = request(url, {
        cache: "no-store",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        signal: controller.signal,
      });
    } catch (cause: unknown) {
      return {
        kind: "requestRejected",
        causeType: cause instanceof Error ? cause.name : typeof cause,
      };
    }
    const lateSettlement: Promise<GatewayRequestSettlement> = response.then(
      (settled): GatewayRequestSettlement => ({
        kind: "response",
        httpStatus: settled.status,
      }),
      (cause: unknown): GatewayRequestSettlement => ({
        kind: "requestRejected",
        causeType: cause instanceof Error ? cause.name : typeof cause,
      }),
    );
    const deadline = new Promise<GatewayRequestOutcome>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve({ kind: "timeout", lateSettlement });
        controller.abort();
      }, timeoutMs);
    });
    const requestOutcome = new Promise<GatewayRequestOutcome>((resolve) => {
      void response.then(
        (settled) => {
          if (!timedOut) resolve({ kind: "response", response: settled });
        },
        (cause: unknown) => {
          if (!timedOut) {
            resolve({
              kind: "requestRejected",
              causeType: cause instanceof Error ? cause.name : typeof cause,
            });
          }
        },
      );
    });
    return await Promise.race([
      requestOutcome,
      deadline,
    ]);
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
