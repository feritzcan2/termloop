import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayReachabilityError,
  probeGatewayCompatibility,
  waitForGatewayReachability,
} from "../src/adapters/production/gateway-compatibility";
import type { SavedConnection } from "../src/platform/secure-connections";

const connection = {
  controlUrl: "wss://mac.example.ts.net/control",
} as SavedConnection;

describe("gateway compatibility probe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("works when React Native has no AbortSignal.timeout static", async () => {
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    });
    const urls: string[] = [];
    try {
      const outcome = await probeGatewayCompatibility(connection, vi.fn(async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({
          buildId: `sha256:${"a".repeat(64)}`,
          compatibility: {
            mobileTransport: { min: 2, max: 2 },
            mobileApi: { min: 1, max: 1 },
          },
        }), { status: 200 });
      }) as typeof fetch);

      expect(outcome).toBe("reachable");
      expect(urls).toEqual(expect.arrayContaining([
        "https://mac.example.ts.net/.well-known/termloop-mobile-access",
        "https://mac.example.ts.net/health",
      ]));
    } finally {
      if (timeoutDescriptor === undefined) delete (AbortSignal as { timeout?: unknown }).timeout;
      else Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    }
  });

  it("bounds two concurrent unreachable probes to one timeout window", async () => {
    vi.useFakeTimers();
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    const outcome = probeGatewayCompatibility(connection, request);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(900);

    await expect(outcome).resolves.toBe("unreachable");
  });

  it("proves the secret-free health route before a WebSocket is created", async () => {
    const urls: string[] = [];
    const request = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(null, { status: 200 });
    });

    await expect(waitForGatewayReachability(
      connection,
      request as typeof fetch,
    )).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledOnce();
    expect(urls).toEqual(["https://mac.example.ts.net/health"]);
  });

  it("classifies immediate native request rejection without retaining its message", async () => {
    const request = vi.fn(async () => {
      throw new TypeError("Network request failed for https://private.example.ts.net/health");
    }) as typeof fetch;

    const failure = await waitForGatewayReachability(connection, request).catch((cause) => cause);

    expect(failure).toMatchObject({
      name: "GatewayReachabilityError",
      reason: "requestRejected",
      requestCauseType: "TypeError",
    });
    expect(failure).toBeInstanceOf(GatewayReachabilityError);
    expect(JSON.stringify(failure)).not.toContain("private.example.ts.net");
  });

  it("classifies a reachable HTTP listener that rejects its health request", async () => {
    const request = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch;

    await expect(waitForGatewayReachability(connection, request)).rejects.toMatchObject({
      name: "GatewayReachabilityError",
      reason: "httpResponse",
      httpStatus: 503,
    });
  });

  it("bounds a Tailnet wake-up that never answers", async () => {
    vi.useFakeTimers();
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    const waking = waitForGatewayReachability(connection, request);
    const rejected = expect(waking).rejects.toMatchObject({
      name: "GatewayReachabilityError",
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(4_000);

    await rejected;
  });
});
