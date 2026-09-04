import { describe, expect, it, vi } from "vitest";
import {
  invalidPushDeviceReason,
  pushRelayOf,
  sendPushRelay,
} from "../scripts/mobile-access-push-relay.mjs";

const relay = {
  url: "https://push.example.test",
  installationId: "a".repeat(32),
  token: "b".repeat(64),
};

describe("mobile push relay client", () => {
  it("requires a complete HTTPS credential set", () => {
    expect(pushRelayOf({
      pushRelayUrl: relay.url,
      pushRelayInstallationId: relay.installationId,
      pushRelayToken: relay.token,
    })).toEqual(relay);
    expect(pushRelayOf({})).toBeUndefined();
    expect(() => pushRelayOf({ pushRelayUrl: relay.url })).toThrow("incomplete");
    expect(() => pushRelayOf({
      pushRelayUrl: "http://push.example.test",
      pushRelayInstallationId: relay.installationId,
      pushRelayToken: relay.token,
    })).toThrow("URL is invalid");
  });

  it("sends one bounded batch without placing credentials in the URL", async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://push.example.test/v1/push");
      expect(String(url)).not.toContain(relay.installationId);
      expect(String(url)).not.toContain(relay.token);
      expect(init.headers.authorization).toBe(`Bearer ${relay.token}`);
      expect(JSON.parse(init.body)).toMatchObject({
        version: 1,
        installationId: relay.installationId,
      });
      return new Response(JSON.stringify({
        version: 1,
        results: [{ index: 0, ok: true, status: 200 }],
      }), { status: 200 });
    });
    const result = await sendPushRelay(relay, [device()], fetch);
    expect(result).toMatchObject({ ok: true, results: [{ index: 0, ok: true, status: 200 }] });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed responses and recognizes terminal APNs tokens", async () => {
    const malformed = await sendPushRelay(relay, [device()], async () => new Response(JSON.stringify({
      version: 1,
      results: [{ index: 1, ok: true }],
    }), { status: 200 }));
    expect(malformed).toMatchObject({ ok: false, reason: "invalidResponse" });
    expect(invalidPushDeviceReason("Unregistered")).toBe(true);
    expect(invalidPushDeviceReason("TooManyRequests")).toBe(false);
  });
});

function device() {
  return {
    deviceToken: "c".repeat(64),
    environment: "development",
    bundleId: "ai.termloop.mobile",
    payload: { aps: { alert: { title: "Ready", body: "Done" } } },
  };
}
