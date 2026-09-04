import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import worker, { type RelayEnv } from "../src";
import { network } from "./network";
import { fixture } from "./validation.test";

describe("mobile push relay worker", () => {
  it("exposes only a minimal health response", async () => {
    const response = await relayFetch(new Request("https://relay.test/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true, version: 1 });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("pins each installation credential and relays a validated APNs request", async () => {
    const request = { ...fixture(), installationId: "c".repeat(32) };
    let apnsBody: unknown;
    network.use(http.post(
      `https://api.sandbox.push.apple.com/3/device/${"b".repeat(64)}`,
      async ({ request: apnsRequest }) => {
        apnsBody = await apnsRequest.json();
        return new HttpResponse(null, { status: 200 });
      },
    ));
    const response = await push(request, "d".repeat(64));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      results: [{ index: 0, ok: true, status: 200 }],
    });
    expect(apnsBody).toMatchObject({
      connectionId: "mac-0123456789abcdef",
      sessionId: "session-1",
      body: {
        connectionId: "mac-0123456789abcdef",
        sessionId: "session-1",
      },
    });

    const refused = await push(request, "e".repeat(64));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ version: 1, error: "unauthorized" });
  });

  it("rejects malformed and over-broad requests before APNs", async () => {
    expect((await relayFetch(new Request("https://relay.test/v1/push", { method: "POST" }))).status).toBe(401);
    const invalid = await push({ ...fixture(), installationId: "guessable" }, "f".repeat(64));
    expect(invalid.status).toBe(400);
  });
});

function push(body: unknown, token: string): Promise<Response> {
  return relayFetch(new Request("https://relay.test/v1/push", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }));
}

async function relayFetch(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], env as RelayEnv, context);
  await waitOnExecutionContext(context);
  return response;
}
