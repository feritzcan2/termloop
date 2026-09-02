import { afterEach, describe, expect, it, vi } from "vitest";

import {
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

  it("bounds a Tailnet wake-up that never answers", async () => {
    vi.useFakeTimers();
    const request = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;

    const waking = waitForGatewayReachability(connection, request);
    const rejected = expect(waking).rejects.toThrow("not reachable");
    await vi.advanceTimersByTimeAsync(4_000);

    await rejected;
  });
});
